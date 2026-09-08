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
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/model"
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
}

// Why an item did not happen. A closed set: the panel renders these, and a
// string it does not know falls back to the English reason beside it.
const (
	reasonGone      = "gone"      // the file or entry is no longer there
	reasonChanged   = "changed"   // it changed after the plan was made
	reasonForbidden = "forbidden" // the person may not do this to it
	reasonMissing   = "missing"   // the thing being acted on is already gone
	reasonBroken    = "broken"    // something failed outright
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

// createPlan stores a proposal and returns the tool result plus the card the
// person will decide on.
func (t *assistantTools) createPlan(ctx context.Context, kind, summary string, items []planItem) assistant.ToolOutcome {
	if len(items) == 0 {
		return failure("there is nothing to do: the plan came out empty")
	}
	if cap := planCap(kind); len(items) > cap {
		return failure("a %s plan may cover at most %d items and this one has %d; propose a narrower one", kind, cap, len(items))
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
	entries, _, err := t.trash.List(ctx, nil, true, model.MaxPlanItems+1, 0)
	if err != nil {
		return failure("the trash could not be read: %v", err)
	}
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
	if !approve {
		if _, err := h.Store.FinishAssistantPlan(r.Context(), plan.ID, model.PlanCancelled, "{}"); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": model.PlanCancelled})
		return
	}
	if h.Tools == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "this server cannot run plans"})
		return
	}
	results := h.runPlan(r, plan)
	payload, err := json.Marshal(map[string]any{"items": results})
	if err != nil {
		payload = []byte("{}")
	}
	// ⚠ Claimed BEFORE the result is reported, and only from pending: two
	// approvals racing leave one winner. The work itself is idempotent per
	// item (a tag set twice is one tag, a purge of a gone node is a skip), but
	// a restore run twice would take a version back over a version.
	ran, err := h.Store.FinishAssistantPlan(r.Context(), plan.ID, model.PlanDone, string(payload))
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
	})
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

// runPlan executes each item, in order, as the person who approved it.
func (h *Assistant) runPlan(r *http.Request, plan *model.AssistantPlan) []planItemResult {
	var items []planItem
	if err := json.Unmarshal([]byte(plan.ItemsJSON), &items); err != nil {
		return []planItemResult{{State: itemFailed, Code: reasonBroken, Reason: "the stored plan could not be read"}}
	}
	tools := newAssistantTools(*h.Tools, plan.SessionID)
	ctx := r.Context()
	out := make([]planItemResult, 0, len(items))
	for _, item := range items {
		out = append(out, tools.runItem(ctx, plan.Kind, item))
	}
	return out
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
