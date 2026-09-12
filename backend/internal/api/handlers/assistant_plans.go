// Package handlers — assistant_plans.go
//
// The half of the assistant that changes things, and the reason it is safe to
// let a language model near it at all.
//
// # The model proposes; the server executes
//
// There is no tool the model can call that tags, restores, revokes or deletes.
// Its tools only WRITE A PLAN: each item resolved to a node id and fingerprinted
// as it is right now, stored in assistant_plans, shown to the person. When they
// approve, THIS file executes what the row says. The model is not consulted at
// execution time and cannot influence a single item of it, so a prompt injection
// that talks the model into "delete everything" produces, at worst, a plan the
// person is looking at and can refuse.
//
// # The fingerprint
//
// Between proposing and approving, a file can be edited, moved, replaced or
// deleted — by another client, another person, a sync run. An item whose
// fingerprint no longer matches is SKIPPED and reported: the person approved
// the file they were shown, not whatever now sits at that path.
//
// # Permissions are checked twice, as the person
//
// Once while the plan is built and once again at execution. Both run inside the
// requesting person's context and through the same ACL helpers the rest of the
// API uses. The versions endpoints, notably, do NOT check ACL themselves (they
// take a node id and act) — so this file checks ≥editor itself rather than
// inheriting that gap.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/perm"
	"github.com/brf-tech/filex/backend/internal/share"
)

// planItem is one unit of approved work. It carries what was resolved, not what
// was typed: a path here is for the person to read, and the node id is what the
// executor acts on.
type planItem struct {
	Path   string `json:"path"`
	NodeID int64  `json:"node_id"`
	// Action is a CODE for what will happen to this item; the interface says it
	// in the reader's language. Args carries whatever that wording needs.
	Action string            `json:"action"`
	Args   map[string]string `json:"args,omitempty"`
	// Size and At are the item as it was when the plan was made, so the list
	// can be read without opening anything. Formatted by the interface.
	Size int64  `json:"size,omitempty"`
	At   string `json:"at,omitempty"`
	// Fingerprint has to still match at execution time.
	Fingerprint string `json:"fingerprint"`
	// Per-kind payload.
	Tags      []string `json:"tags,omitempty"`
	VersionID int64    `json:"version_id,omitempty"`
	ShareID   int64    `json:"share_id,omitempty"`
	// Target is the folder a move item goes into, as an address.
	Target string `json:"target,omitempty"`
}

// planItemResult is what happened to one item.
type planItemResult struct {
	Path string `json:"path"`
	// State is "done", "skipped" or "failed".
	State string `json:"state"`
	// Code is why, from a closed set, so the interface can say it in the
	// person's language. Reason is the same thing in English, kept for logs and
	// for anything the code does not cover.
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason,omitempty"`
	// URL is set by the one kind that PRODUCES something the person needs to
	// be handed: a share link. It is stored with the answer and redrawn when
	// the conversation is reopened, which is deliberate — a link nobody was
	// shown is a link nobody can use. The consequence is stated in the docs:
	// the URL is a credential and it stays in the transcript after the link is
	// revoked, so what is read there is a record of what was minted, not proof
	// the link still opens.
	URL string `json:"url,omitempty"`
}

// Why an item did not happen. A closed set: the panel renders these, and a
// string it does not know falls back to the English reason beside it.
const (
	reasonGone      = "gone"      // the file or entry is no longer there
	reasonChanged   = "changed"   // it changed after the plan was made
	reasonForbidden = "forbidden" // the person may not do this to it
	reasonMissing   = "missing"   // the thing being acted on is already gone
	reasonBroken    = "broken"    // something failed outright
	reasonTaken     = "taken"     // the destination name is already in use
)

// skip / fail record an outcome with both halves: the code the interface reads
// and the sentence a log reader does.
func (r planItemResult) skip(code, reason string) planItemResult {
	r.State, r.Code, r.Reason = itemSkipped, code, reason
	return r
}

func (r planItemResult) fail(reason string) planItemResult {
	r.State, r.Code, r.Reason = itemFailed, reasonBroken, reason
	return r
}

func (r planItemResult) ok() planItemResult {
	r.State = itemDone
	return r
}

// link records a success that produced a URL the person has to be given.
func (r planItemResult) link(url string) planItemResult {
	r.State, r.URL = itemDone, url
	return r
}

// Plan outcome states.
const (
	itemDone    = "done"
	itemSkipped = "skipped"
	itemFailed  = "failed"
)

// planCap is how many items this kind of plan may carry. Tagging gets the
// generous ceiling because it adds a label and destroys nothing; everything
// else gets the one a person can actually read through before approving.
func planCap(kind string) int {
	if kind == model.PlanKindTags {
		return model.MaxPlanTagItems
	}
	return model.MaxPlanItems
}

// overCap is the ceiling refusal, worded once.
//
// ⚠ It is asked BEFORE the paths are resolved as well as after the items are
// built. Resolving one path is a drive listing, a grants read and a node lookup;
// a model — or an injection in a file it was allowed to read — naming a thousand
// paths used to spend all of those queries and only then be told the plan was
// too long to store, without a person having approved anything.
func overCap(kind string, count int) assistant.ToolOutcome {
	return failure("a %s plan may cover at most %d items and this one has %d; propose a narrower one", kind, planCap(kind), count)
}

// createPlan stores a proposal and returns the tool result plus the card the
// person will decide on.
func (t *assistantTools) createPlan(ctx context.Context, kind, summary string, items []planItem) assistant.ToolOutcome {
	if len(items) == 0 {
		return failure("there is nothing to do: the plan came out empty")
	}
	if len(items) > planCap(kind) {
		return overCap(kind, len(items))
	}
	raw, err := json.Marshal(items)
	if err != nil {
		return failure("the plan could not be recorded: %v", err)
	}
	plan, err := t.store.CreateAssistantPlan(ctx, &model.AssistantPlan{
		SessionID: t.sessionID,
		Kind:      kind,
		Summary:   strings.TrimSpace(summary),
		ItemsJSON: string(raw),
	})
	if err != nil {
		return failure("the plan could not be recorded: %v", err)
	}
	return assistant.ToolOutcome{
		Content: jsonString(map[string]any{
			"plan_id": plan.ID,
			"status":  "waiting for the person to approve or refuse it",
			"items":   len(items),
			"next":    "tell them what the plan does, in one or two sentences, and stop. Do not act, do not propose the same plan again, and do not ask a second time.",
		}),
		Card: &assistant.Card{
			Kind:     assistant.CardPlan,
			PlanKind: plan.Kind,
			PlanID:   strconv.FormatInt(plan.ID, 10),
			Summary:  plan.Summary,
			Items:    cardItems(items),
		},
	}
}

// cardItems is the plan as the person reads it.
func cardItems(items []planItem) []assistant.CardItem {
	out := make([]assistant.CardItem, 0, len(items))
	for _, item := range items {
		out = append(out, assistant.CardItem{Path: item.Path, Action: item.Action, Args: item.Args, Size: item.Size, At: item.At})
	}
	return out
}

// nodeFingerprint is the file as it is now: its size, its content hash and the
// moment it last changed. Any of the three moving means this is no longer the
// file the person approved.
func nodeFingerprint(n *model.Node) string {
	mtime := int64(0)
	if n.BackendMtime != nil {
		mtime = n.BackendMtime.Unix()
	}
	return fmt.Sprintf("%d:%s:%d", n.Size, n.Etag, mtime)
}

// ─────────────────────────── building the plans ───────────────────────────

func (t *assistantTools) planTags(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Paths   []string `json:"paths"`
		Tags    []string `json:"tags"`
		Summary string   `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	tags := cleanTags(args.Tags)
	if len(tags) == 0 {
		return failure("no tags were given")
	}
	if len(args.Paths) > planCap(model.PlanKindTags) {
		return overCap(model.PlanKindTags, len(args.Paths))
	}
	items := make([]planItem, 0, len(args.Paths))
	for _, path := range args.Paths {
		node, err := t.resolveNode(ctx, path)
		if err != nil {
			// One unreachable path does not spoil the plan; it is reported so
			// the model can tell the person which one it could not find.
			items = append(items, planItem{Path: path})
			continue
		}
		items = append(items, planItem{
			Path:        path,
			NodeID:      node.ID,
			Action:      assistant.ActionTag,
			Args:        map[string]string{"tags": strings.Join(tags, ", ")},
			Size:        node.Size,
			Fingerprint: nodeFingerprint(node),
			Tags:        tags,
		})
	}
	// Items that could not be resolved are dropped before the plan is stored:
	// a plan is a list of work, not a list of complaints.
	items = resolvedOnly(items)
	return t.createPlan(ctx, model.PlanKindTags, args.Summary, items)
}

func (t *assistantTools) planRestoreVersion(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Path      string `json:"path"`
		VersionID int64  `json:"version_id"`
		Summary   string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	node, err := t.resolveNode(ctx, args.Path)
	if err != nil {
		return failure("%v", err)
	}
	if !t.mayWrite(ctx, args.Path) {
		return failure("you do not have permission to change %s", args.Path)
	}
	versions, err := t.versions.List(ctx, node.ID)
	if err != nil {
		return failure("the versions of %s could not be read: %v", args.Path, err)
	}
	for _, v := range versions {
		if v.ID != args.VersionID {
			continue
		}
		return t.createPlan(ctx, model.PlanKindRestoreVersion, args.Summary, []planItem{{
			Path:        args.Path,
			NodeID:      node.ID,
			Action:      assistant.ActionRestoreVersion,
			Args:        map[string]string{"version": strconv.Itoa(v.VersionN)},
			Size:        v.Size,
			At:          v.CreatedAt.UTC().Format(time.RFC3339),
			Fingerprint: nodeFingerprint(node),
			VersionID:   v.ID,
		}})
	}
	return failure("%s has no version with id %d — list its versions first", args.Path, args.VersionID)
}

// planCreateShare proposes a public link.
//
// This is the only thing the assistant can propose that reaches OUTSIDE the
// installation: a share URL opens without signing in, so approving it hands
// access to whoever holds the link. Two consequences are built in here rather
// than left to the model.
//
// The fingerprint is the file as it stands. If the bytes change between the
// proposal and the approval, the link is not minted — the person approved a
// link to what they were shown, and publishing something else under that
// approval is exactly the mistake this whole plan mechanism exists to prevent.
//
// Existing links are counted into the plan item, so "share the report" on a
// file that already has a link says so before anybody approves a second one.
func (t *assistantTools) planCreateShare(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Path    string `json:"path"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	if t.share == nil {
		return failure("sharing is not enabled on this server")
	}
	node, err := t.resolveNode(ctx, args.Path)
	if err != nil {
		return failure("%v", err)
	}
	// Checked here as well as at execution: a plan the person cannot approve
	// is worse than a refusal, because they have to read it to find that out.
	if !t.mayWriteNode(ctx, node) {
		return failure("you do not have permission to share %s", args.Path)
	}
	existing, err := t.share.ListByNode(ctx, node.ID)
	if err != nil {
		return failure("the links on %s could not be read: %v", args.Path, err)
	}
	return t.createPlan(ctx, model.PlanKindCreateShare, args.Summary, []planItem{{
		Path:        args.Path,
		NodeID:      node.ID,
		Action:      assistant.ActionCreateShare,
		Args:        map[string]string{"existing": strconv.Itoa(len(existing))},
		Size:        node.Size,
		Fingerprint: nodeFingerprint(node),
	}})
}

func (t *assistantTools) planRevokeShare(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Path    string `json:"path"`
		ShareID int64  `json:"share_id"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	if t.share == nil {
		return failure("sharing is not enabled on this server")
	}
	node, err := t.resolveNode(ctx, args.Path)
	if err != nil {
		return failure("%v", err)
	}
	shares, err := t.share.ListByNode(ctx, node.ID)
	if err != nil {
		return failure("the links on %s could not be read: %v", args.Path, err)
	}
	for _, sh := range shares {
		if sh.ID != args.ShareID {
			continue
		}
		// The rule execution applies — your own links, unless you are an
		// administrator — asserted here too, for the reason planCreateShare
		// states: a plan the person cannot approve is worse than a refusal,
		// because they have to read it to find that out.
		if u := auth.UserFrom(ctx); u != nil && !u.IsAdmin() && (sh.CreatedBy == nil || *sh.CreatedBy != u.ID) {
			return failure("the link with id %d on %s was created by somebody else; only its creator or an administrator can close it", args.ShareID, args.Path)
		}
		return t.createPlan(ctx, model.PlanKindRevokeShare, args.Summary, []planItem{{
			Path:   args.Path,
			NodeID: node.ID,
			Action: assistant.ActionRevokeShare,
			Args:   map[string]string{"downloads": strconv.Itoa(sh.DownloadCount)},
			At:     sh.CreatedAt.UTC().Format(time.RFC3339),
			// The token, not the file: revoking is about the link, and the
			// file underneath it may legitimately have changed.
			Fingerprint: sh.Token,
			ShareID:     sh.ID,
		}})
	}
	return failure("%s has no link with id %d — list its links first", args.Path, args.ShareID)
}

func (t *assistantTools) planEmptyTrash(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	if t.trash == nil {
		return failure("the trash is not available on this server")
	}
	entries, _, err := t.trash.List(ctx, nil, true, db.NodeFacets{}, assistantTrashScan, 0)
	if err != nil {
		return failure("the trash could not be read: %v", err)
	}
	// ⚠ Filtered to this person's own entries BEFORE the cap is applied. The
	// listing is the installation's, so the ceiling used to be counted over
	// everybody's deleted files — and the plan itself would have named them.
	entries = t.ownTrash(ctx, entries)
	if len(entries) > model.MaxPlanItems {
		return failure("there are more than %d items in the trash; emptying it is more than one plan can carry — the person can empty it from the Trash page in one action", model.MaxPlanItems)
	}
	items := make([]planItem, 0, len(entries))
	for _, e := range entries {
		items = append(items, planItem{
			Path:   e.StorageName + "://" + strings.TrimPrefix(e.Path, "/"),
			NodeID: e.ID,
			// The interface says this one in the plainest words its language
			// has. It is the only operation here that nothing can undo.
			Action:      assistant.ActionPurge,
			Size:        e.Size,
			At:          e.DeletedAt.UTC().Format(time.RFC3339),
			Fingerprint: strconv.FormatInt(e.DeletedAt.Unix(), 10),
		})
	}
	return t.createPlan(ctx, model.PlanKindEmptyTrash, args.Summary, items)
}

// planMove proposes moving files and folders into one folder, creating the
// folder first when it is not there yet.
//
// Moving is the one verb here that touches a live file, and it is allowed
// because it is reversible by the person (move it back) and because the plan
// names every source and the destination in full — the "moved somewhere nobody
// can find" the prompt warns about is a move nobody read. What it will not do
// is overwrite: a name already taken in the destination is refused here and
// skipped again at execution, and a move into itself is refused outright.
//
// ⚠ A path that does not resolve fails the WHOLE proposal, unlike plan_tags.
// A list the person reads and approves must be the list they asked for; a plan
// that quietly lacks one of the files they named is worse than no plan.
func (t *assistantTools) planMove(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Paths   []string `json:"paths"`
		Target  string   `json:"target"`
		Summary string   `json:"summary"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	if len(args.Paths) > planCap(model.PlanKindMove) {
		return overCap(model.PlanKindMove, len(args.Paths))
	}
	drive, targetRel, err := t.ops.resolveStorage(ctx, strings.TrimSpace(args.Target))
	if err != nil {
		return failure("%v", err)
	}
	target := joinAdapterPath(drive.Name, targetRel)
	if drive.ReadOnly {
		return failure("%s is read-only", drive.Name)
	}
	if !t.ops.allow(ctx, drive, targetRel, acl.LevelEditor) {
		return failure("you do not have permission to put anything into %s", target)
	}
	var items []planItem
	if targetRel != "" {
		existing := t.liveNode(ctx, drive, targetRel)
		switch {
		case existing != nil && existing.Type != model.NodeTypeDirectory:
			return failure("%s is a file, not a folder", target)
		case existing == nil:
			// One new folder per plan, under a folder that exists: a chain of
			// new folders is a plan nobody can check against anything.
			if parent := path.Dir(targetRel); parent != "." {
				if above := t.liveNode(ctx, drive, parent); above == nil || above.Type != model.NodeTypeDirectory {
					return failure("the folder above %s does not exist; create one level at a time, or pick an existing folder", target)
				}
			}
			items = append(items, planItem{Path: target, Action: assistant.ActionMkdir})
		}
	}
	creating := len(items) == 1
	seen := map[int64]bool{}
	for _, p := range args.Paths {
		node, err := t.resolveNode(ctx, p)
		if err != nil {
			return failure("%v", err)
		}
		if node.StorageID != drive.ID {
			return failure("%s is on another drive; moving between drives is not something this assistant proposes", p)
		}
		srcRel := strings.Trim(node.Path, "/")
		address := joinAdapterPath(drive.Name, srcRel)
		if srcRel == targetRel || strings.HasPrefix(targetRel, srcRel+"/") {
			return failure("%s cannot be moved into itself", address)
		}
		if parent := path.Dir(srcRel); parent == targetRel || (parent == "." && targetRel == "") {
			return failure("%s is already in %s", address, target)
		}
		if !t.mayWriteNode(ctx, node) {
			return failure("you do not have permission to move %s", address)
		}
		if !creating && t.occupied(ctx, drive.ID, path.Join(targetRel, node.Name)) {
			return failure("%s already holds something named %s; nothing is overwritten — ask the person how they want that resolved", target, node.Name)
		}
		if seen[node.ID] {
			continue
		}
		seen[node.ID] = true
		items = append(items, planItem{
			Path:        address,
			NodeID:      node.ID,
			Action:      assistant.ActionMove,
			Args:        map[string]string{"target": target},
			Size:        node.Size,
			Fingerprint: nodeFingerprint(node),
			Target:      target,
		})
	}
	if len(seen) == 0 {
		return failure("there is nothing to move: no paths were given")
	}
	return t.createPlan(ctx, model.PlanKindMove, args.Summary, items)
}

// liveNode is the row at rel, or nil when the drive has nothing there and it is
// in the trash. A path the cache has never seen but the driver holds is
// catalogued rather than reported missing — see catalogue for why the cache
// alone is not an answer here.
func (t *assistantTools) liveNode(ctx context.Context, drive *model.Storage, rel string) *model.Node {
	node, err := t.store.GetNodeByPath(ctx, drive.ID, pathkey.Hash(drive.ID, rel))
	if err != nil || node == nil {
		return t.catalogue(ctx, drive, rel)
	}
	if node.DeletedAt != nil {
		return nil
	}
	return node
}

// occupied asks the DRIVER whether anything sits at rel. The cache is what a
// listing shows; the disk is what a move would overwrite, and a file written
// by another protocol may be on the second before it is in the first.
func (t *assistantTools) occupied(ctx context.Context, storageID int64, rel string) bool {
	drv, err := t.ops.resolver(storageID)
	if err != nil {
		return false
	}
	_, err = drv.Stat(ctx, rel)
	return err == nil
}

// resolvedOnly drops the items that never resolved to a node.
func resolvedOnly(items []planItem) []planItem {
	out := items[:0]
	for _, item := range items {
		if item.NodeID != 0 {
			out = append(out, item)
		}
	}
	return out
}

// cleanTags trims, drops empties and de-duplicates, preserving the order the
// model asked for.
func cleanTags(raw []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(raw))
	for _, tag := range raw {
		tag = strings.TrimSpace(tag)
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		out = append(out, tag)
	}
	return out
}

// ─────────────────────────── executing a plan ───────────────────────────

// Plans lists this conversation's plans with their current state. The panel
// draws a stored card from these rather than from the frozen message payload:
// a plan that has since been run must not still be showing an Approve button.
func (h *Assistant) planViews(ctx context.Context, sessionID int64) map[string]map[string]any {
	rows, err := h.Store.ListAssistantPlans(ctx, sessionID)
	if err != nil {
		return nil
	}
	out := map[string]map[string]any{}
	for _, plan := range rows {
		out[strconv.FormatInt(plan.ID, 10)] = planView(plan)
	}
	return out
}

// planView is one plan on the wire.
func planView(plan *model.AssistantPlan) map[string]any {
	var items []planItem
	_ = json.Unmarshal([]byte(plan.ItemsJSON), &items)
	view := map[string]any{
		"plan_kind": plan.Kind,
		"summary":   plan.Summary,
		"status":    plan.Status,
		"items":     cardItems(items),
	}
	var result struct {
		Items []planItemResult `json:"items"`
	}
	if json.Unmarshal([]byte(plan.ResultJSON), &result) == nil && len(result.Items) > 0 {
		view["results"] = result.Items
	}
	return view
}

// ApprovePlan runs the work the person approved.
//
//	POST /api/assistant/sessions/{id}/plans/{planID}/approve
//
// ⚠ The body carries no work. Everything that will happen is already in the
// row, resolved and fingerprinted at proposal time — a request that could
// describe the work would be a request a compromised client could rewrite.
func (h *Assistant) ApprovePlan(w http.ResponseWriter, r *http.Request) {
	h.decidePlan(w, r, true)
}

// CancelPlan drops a plan without running it.
func (h *Assistant) CancelPlan(w http.ResponseWriter, r *http.Request) {
	h.decidePlan(w, r, false)
}

func (h *Assistant) decidePlan(w http.ResponseWriter, r *http.Request, approve bool) {
	session, ok := h.own(w, r)
	if !ok {
		return
	}
	planID, err := strconv.ParseInt(chi.URLParam(r, "planID"), 10, 64)
	if err != nil || planID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad plan id"})
		return
	}
	plan, err := h.Store.GetAssistantPlan(r.Context(), planID)
	// A plan belonging to another conversation answers "not found" for the same
	// reason a session does: its existence is somebody else's business.
	if err != nil || plan == nil || plan.SessionID != session.ID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if plan.Status != model.PlanPending {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this plan was already decided", "status": plan.Status})
		return
	}
	if approve && h.Tools == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "this server cannot run plans"})
		return
	}
	// ⚠⚠ Claimed BEFORE anything is done, not after. The status read above is
	// only a cheap early answer; this is the one that decides, because two
	// approvals racing (a double click, a retried request, two tabs) both pass
	// that read. Claiming afterwards meant both ran the work and one of them
	// threw its own result away — for create_share, a second public link whose
	// URL was never shown to anybody.
	claimed, err := h.Store.ClaimAssistantPlan(r.Context(), plan.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !claimed {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this plan was already decided"})
		return
	}
	// ⚠ From here the request's cancellation is not consulted. A client that
	// hangs up mid-execution used to leave the row pending with part of the
	// work already done, ready to be approved a second time; the plan is
	// claimed now, so it has to be carried to a stored outcome whatever the
	// connection does.
	ctx := context.WithoutCancel(r.Context())
	if !approve {
		if _, err := h.Store.FinishAssistantPlan(ctx, plan.ID, model.PlanCancelled, "{}"); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "status": model.PlanCancelled,
			"message": h.notePlanDecision(ctx, plan, model.PlanCancelled, 0, 0, 0),
		})
		return
	}
	results := h.runPlan(ctx, r, plan)
	payload, err := json.Marshal(map[string]any{"items": results})
	if err != nil {
		payload = []byte("{}")
	}
	ran, err := h.Store.FinishAssistantPlan(ctx, plan.ID, model.PlanDone, string(payload))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ran {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this plan was already decided"})
		return
	}
	done, skipped, failed := countStates(results)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "status": model.PlanDone, "items": results,
		"done": done, "skipped": skipped, "failed": failed,
		"message": h.notePlanDecision(ctx, plan, model.PlanDone, done, skipped, failed),
	})
}

// planDecision is the executor's line about one plan: what the person decided
// and what the server then did with it.
//
// ⚠ Status and the counts are CODES and numbers, not a sentence, for the same
// reason a plan item's action is one: the panel is read in three languages and
// words this itself. The English sentence stored beside it is for the MODEL.
type planDecision struct {
	PlanID   string `json:"plan_id"`
	PlanKind string `json:"plan_kind"`
	Status   string `json:"status"`
	Done     int    `json:"done"`
	Skipped  int    `json:"skipped"`
	Failed   int    `json:"failed"`
}

// notePlanDecision writes the outcome into the conversation as a message of the
// executor's own — role `system`, a third side beside the person and the model —
// and returns it as the wire carries it, so the panel can show it without
// re-reading the conversation.
//
// ⚠ The panel used to report this by SENDING a chat turn worded as the person
// ("I did not approve that plan"): words nobody typed, a whole model turn spent
// answering them, and a transcript that misattributed both. Nothing is asked of
// the model here — it reads this as history the next time the person asks
// something.
func (h *Assistant) notePlanDecision(ctx context.Context, plan *model.AssistantPlan, status string, done, skipped, failed int) map[string]any {
	decision := planDecision{
		PlanID:   strconv.FormatInt(plan.ID, 10),
		PlanKind: plan.Kind,
		Status:   status,
		Done:     done,
		Skipped:  skipped,
		Failed:   failed,
	}
	payload, err := json.Marshal(map[string]any{"plan_decision": decision})
	if err != nil {
		return nil
	}
	stored, err := h.Store.AppendAssistantMessage(ctx, &model.AssistantMessage{
		SessionID:   plan.SessionID,
		Role:        model.AssistantRoleSystem,
		Content:     planDecisionLine(decision),
		PayloadJSON: string(payload),
	})
	if err != nil {
		// The work is done and recorded on the plan row itself. A note that
		// could not be stored is a gap in the transcript, not a reason to
		// answer with an error the person would react to by pressing the
		// button a second time.
		slog.Error("assistant: storing the plan decision failed", slog.Any("error", err), slog.Int64("plan", plan.ID))
		return nil
	}
	return map[string]any{
		"id":            strconv.FormatInt(stored.ID, 10),
		"role":          stored.Role,
		"content":       stored.Content,
		"created_at":    stored.CreatedAt.UTC().Format(time.RFC3339),
		"plan_decision": decision,
	}
}

// planDecisionLine is the note as the MODEL reads it. English and plain: the
// person never sees this string — the panel draws the payload beside it.
func planDecisionLine(d planDecision) string {
	if d.Status == model.PlanCancelled {
		return fmt.Sprintf("The person refused plan %s (%s). Nothing was done.", d.PlanID, d.PlanKind)
	}
	return fmt.Sprintf("The person approved plan %s (%s) and the server ran it: %d done, %d not done.",
		d.PlanID, d.PlanKind, d.Done, d.Skipped+d.Failed)
}

func countStates(results []planItemResult) (done, skipped, failed int) {
	for _, r := range results {
		switch r.State {
		case itemDone:
			done++
		case itemSkipped:
			skipped++
		default:
			failed++
		}
	}
	return
}

// runPlan executes each item, in order, as the person who approved it. The
// context is the caller's, deliberately detached from the connection — see
// decidePlan.
func (h *Assistant) runPlan(ctx context.Context, r *http.Request, plan *model.AssistantPlan) []planItemResult {
	var items []planItem
	if err := json.Unmarshal([]byte(plan.ItemsJSON), &items); err != nil {
		return []planItemResult{{State: itemFailed, Code: reasonBroken, Reason: "the stored plan could not be read"}}
	}
	// ⚠ The per-role operation gate (internal/perm), once per plan and before
	// the first item runs. The assistant is a SECOND DOOR onto work the
	// buttons gate: restoring a version, emptying the trash, tagging, moving,
	// minting a link. A role that lost files.purge must not be able to empty
	// its trash by asking for it in words.
	//
	// Reported as the assistant refusing, with the same `forbidden` code an
	// ACL denial uses, rather than as a 403 over the whole request: the person
	// pressed Approve on a card, and what they get back is that card with
	// every line saying it was not done and why. A 500 would say the server
	// broke; it did not.
	if op, ok := planKindOp(plan.Kind); ok && !permAllowed(r, op) {
		out := make([]planItemResult, 0, len(items))
		for _, item := range items {
			out = append(out, planItemResult{Path: item.Path}.skip(reasonForbidden, "your role may not do this: "+op))
		}
		return out
	}
	tools := newAssistantTools(*h.Tools, plan.SessionID)
	// The origin a minted link lives on is a property of the request, and this
	// is the only place a plan meets one.
	tools.origin = h.Tools.Tenants.FromRequest(r)
	out := make([]planItemResult, 0, len(items))
	for _, item := range items {
		out = append(out, tools.runItem(ctx, plan.Kind, item))
	}
	return out
}

// planKindOp maps a plan kind to the operation permission its work needs. The
// same mapping requirePermForOpKind does for the ops queue, and for the same
// reason: two doors onto one act, one rule.
//
// A kind with no operation reports false and runs as before —
// PlanKindRevokeShare, because closing a link is not minting one and no other
// revoke surface is gated either; a gate here that /api/files/share/{id} and
// /api/ai/unshare do not have would make the assistant stricter than the
// button beside it. PlanKindMove needs files.move alone, not files.mkdir as
// well, for the reason Archive.Extract does not: the destination folder is
// part of the move the person approved, not a folder they asked for.
func planKindOp(kind string) (string, bool) {
	switch kind {
	case model.PlanKindTags:
		return perm.OpTags, true
	case model.PlanKindRestoreVersion:
		return perm.OpRestore, true
	case model.PlanKindCreateShare:
		return perm.OpShare, true
	case model.PlanKindEmptyTrash:
		return perm.OpPurge, true
	case model.PlanKindMove:
		return perm.OpMove, true
	}
	return "", false
}

// runItem is one item's execution, fingerprint check included.
func (t *assistantTools) runItem(ctx context.Context, kind string, item planItem) planItemResult {
	result := planItemResult{Path: item.Path}
	switch kind {
	case model.PlanKindTags:
		node, err := t.store.GetNode(ctx, item.NodeID)
		if err != nil || node == nil || node.DeletedAt != nil {
			return result.skip(reasonGone, "the file is no longer there")
		}
		if nodeFingerprint(node) != item.Fingerprint {
			return result.skip(reasonChanged, "the file changed after the plan was made")
		}
		if !t.mayWriteNode(ctx, node) {
			return result.skip(reasonForbidden, "you do not have permission to change it")
		}
		existing, err := t.store.GetNodeTags(ctx, node.ID)
		if err != nil {
			return result.fail(err.Error())
		}
		// Tags are ADDED. SetNodeTags replaces the whole set, so writing only
		// the new ones would silently strip every tag the person had put there
		// by hand.
		if err := t.store.SetNodeTags(ctx, node.ID, mergeTags(existing, item.Tags)); err != nil {
			return result.fail(err.Error())
		}
		return result.ok()

	case model.PlanKindRestoreVersion:
		node, err := t.store.GetNode(ctx, item.NodeID)
		if err != nil || node == nil || node.DeletedAt != nil {
			return result.skip(reasonGone, "the file is no longer there")
		}
		if nodeFingerprint(node) != item.Fingerprint {
			return result.skip(reasonChanged, "the file changed after the plan was made")
		}
		if !t.mayWriteNode(ctx, node) {
			return result.skip(reasonForbidden, "you do not have permission to change it")
		}
		if t.versions == nil {
			return result.fail("versioning is not available on this server")
		}
		// snapshotCurrent: true, always. The bytes being replaced are somebody's
		// current file, and this is the one place in the assistant where the
		// safety net is real — so it is not optional.
		if err := t.versions.Restore(ctx, node.ID, item.VersionID, true); err != nil {
			return result.fail(err.Error())
		}
		afterVersionRestore(ctx, t.store, t.index, node.ID)
		return result.ok()

	case model.PlanKindCreateShare:
		if t.share == nil {
			return result.fail("sharing is not enabled on this server")
		}
		node, err := t.store.GetNode(ctx, item.NodeID)
		if err != nil || node == nil || node.DeletedAt != nil {
			return result.skip(reasonGone, "the file is no longer there")
		}
		if nodeFingerprint(node) != item.Fingerprint {
			return result.skip(reasonChanged, "the file changed after the plan was made")
		}
		// ≥editor, the level `POST /share` requires: minting a link is an
		// outbound grant of access, not a read.
		if !t.mayWriteNode(ctx, node) {
			return result.skip(reasonForbidden, "you do not have permission to share it")
		}
		var by *int64
		if u := auth.UserFrom(ctx); u != nil {
			id := u.ID
			by = &id
		}
		// No expiry is passed: share.Service.Create clamps a missing one to the
		// installation's max-TTL setting, so the link the assistant mints lives
		// exactly as long as the operator says links may live.
		sh, err := t.share.Create(ctx, share.CreateOpts{NodeID: node.ID, CreatedBy: by})
		if err != nil {
			return result.fail(err.Error())
		}
		return result.link(t.origin + "/s/" + sh.Token)

	case model.PlanKindRevokeShare:
		if t.share == nil {
			return result.fail("sharing is not enabled on this server")
		}
		shares, err := t.share.ListByNode(ctx, item.NodeID)
		if err != nil {
			return result.fail(err.Error())
		}
		for _, sh := range shares {
			if sh.ID != item.ShareID {
				continue
			}
			if sh.Token != item.Fingerprint {
				return result.skip(reasonChanged, "the link changed after the plan was made")
			}
			// The same rule the AI surface applies: your own links, unless you
			// are an administrator.
			if u := auth.UserFrom(ctx); u != nil && !u.IsAdmin() && (sh.CreatedBy == nil || *sh.CreatedBy != u.ID) {
				return result.skip(reasonForbidden, "the link was created by somebody else")
			}
			if err := t.store.RevokeShare(ctx, sh.ID); err != nil {
				return result.fail(err.Error())
			}
			return result.ok()
		}
		return result.skip(reasonMissing, "the link is already gone")

	case model.PlanKindMove:
		return t.runMoveItem(ctx, item)

	case model.PlanKindEmptyTrash:
		if t.trash == nil {
			return result.fail("the trash is not available on this server")
		}
		node, err := t.store.GetNode(ctx, item.NodeID)
		if err != nil || node == nil || node.DeletedAt == nil {
			return result.skip(reasonGone, "it is no longer in the trash")
		}
		if strconv.FormatInt(node.DeletedAt.Unix(), 10) != item.Fingerprint {
			return result.skip(reasonChanged, "the entry changed after the plan was made")
		}
		// Same guard the person's own "delete forever" button uses: the
		// original path, at ≥editor.
		if !t.mayPurgeNode(ctx, node) {
			return result.skip(reasonForbidden, "you do not have permission to destroy it")
		}
		if err := t.trash.PurgeOne(ctx, node.ID); err != nil {
			return result.fail(err.Error())
		}
		return result.ok()
	}
	return result.fail("unknown plan kind: " + kind)
}

// runMoveItem is one line of a move plan: the folder to create, or one item
// to put into it.
//
// The move itself goes through aiOps.Move — the same ACL-checked, cache-aware,
// event-emitting path the MCP surface uses — so this is not a second
// implementation of moving. What this adds is the plan's own promises: the
// item is still the one the person approved (fingerprint AND address, since a
// file moved elsewhere keeps its bytes), the destination exists, and nothing
// already there is written over.
func (t *assistantTools) runMoveItem(ctx context.Context, item planItem) planItemResult {
	result := planItemResult{Path: item.Path}
	if item.Action == assistant.ActionMkdir {
		drive, rel, err := t.ops.resolveStorage(ctx, item.Path)
		if err != nil {
			return result.skip(reasonForbidden, err.Error())
		}
		// Made by hand in the meantime: the folder the plan wanted is there.
		if existing := t.liveNode(ctx, drive, rel); existing != nil && existing.Type == model.NodeTypeDirectory {
			return result.ok()
		}
		if _, err := t.ops.Mkdir(ctx, item.Path); err != nil {
			if errors.Is(err, errAIForbidden) {
				return result.skip(reasonForbidden, "you do not have permission to create it")
			}
			return result.fail(err.Error())
		}
		return result.ok()
	}

	node, err := t.store.GetNode(ctx, item.NodeID)
	if err != nil || node == nil || node.DeletedAt != nil {
		return result.skip(reasonGone, "the item is no longer there")
	}
	if nodeFingerprint(node) != item.Fingerprint {
		return result.skip(reasonChanged, "the item changed after the plan was made")
	}
	drive, targetRel, err := t.ops.resolveStorage(ctx, item.Target)
	if err != nil {
		return result.skip(reasonForbidden, err.Error())
	}
	if joinAdapterPath(drive.Name, strings.Trim(node.Path, "/")) != item.Path {
		return result.skip(reasonChanged, "the item moved after the plan was made")
	}
	if !t.mayWriteNode(ctx, node) {
		return result.skip(reasonForbidden, "you do not have permission to move it")
	}
	// The destination is the folder the plan named — created by the item
	// before this one, or already there. Nothing is moved into a folder that
	// is not there, whatever a driver would make of that.
	if targetRel != "" {
		if folder := t.liveNode(ctx, drive, targetRel); folder == nil || folder.Type != model.NodeTypeDirectory {
			return result.skip(reasonMissing, "the destination folder does not exist")
		}
	}
	dstRel := path.Join(targetRel, node.Name)
	if t.occupied(ctx, drive.ID, dstRel) {
		return result.skip(reasonTaken, "something with that name is already in the destination")
	}
	if _, err := t.ops.Move(ctx, item.Path, joinAdapterPath(drive.Name, dstRel)); err != nil {
		if errors.Is(err, errAIForbidden) {
			return result.skip(reasonForbidden, "you do not have permission to move it")
		}
		return result.fail(err.Error())
	}
	return result.ok()
}

// mergeTags adds without removing. Order is stable so a file's tags do not
// shuffle every time something is added.
func mergeTags(existing, added []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(existing)+len(added))
	for _, tag := range append(append([]string{}, existing...), added...) {
		tag = strings.TrimSpace(tag)
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		out = append(out, tag)
	}
	return out
}

// mayWrite / mayWriteNode / mayPurgeNode are this file's own permission checks.
// They exist rather than being inherited because the endpoints these operations
// normally go through do not all check: /api/files/versions takes a node id and
// restores, with no ACL assertion anywhere in the handler.
func (t *assistantTools) mayWrite(ctx context.Context, path string) bool {
	storage, rel, err := t.ops.resolveStorage(ctx, path)
	if err != nil {
		return false
	}
	return t.ops.allow(ctx, storage, rel, acl.LevelEditor)
}

func (t *assistantTools) mayWriteNode(ctx context.Context, node *model.Node) bool {
	if t.acl == nil {
		return true
	}
	return aclAllowID(ctx, t.acl, t.store, node.StorageID, node.Path, acl.LevelEditor)
}

func (t *assistantTools) mayPurgeNode(ctx context.Context, node *model.Node) bool {
	orig := node.StorageKey
	if orig == "" {
		orig = node.Path
	}
	if t.acl == nil {
		return true
	}
	return aclAllowID(ctx, t.acl, t.store, node.StorageID, orig, acl.LevelEditor)
}
