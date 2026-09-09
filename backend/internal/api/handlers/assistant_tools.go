// Package handlers — assistant_tools.go
//
// The assistant's view of the files: four read-only tools, and the gate in
// front of the one that opens a file.
//
// # Nothing here is a second implementation
//
// Every tool runs through aiOps — the same ACL-checked core the MCP server and
// the REST agent surface use — so the assistant can see exactly what the person
// it is answering could open themselves, no more. resolveStorage is that core's
// single chokepoint and asserts ≥viewer on every path before anything is read.
// Writing a private listing loop here would have meant a second place for
// permissions to be wrong.
//
// # The read gate
//
// read_file refuses unless assistant_read_grants holds the exact path for this
// conversation. That refusal is the enforcement of the owner's rule; the system
// prompt's paragraph about asking first is the courtesy version of it, and a
// model can be talked out of a paragraph. The tool answers the refusal back to
// the model AND emits a card the person can act on, so the conversation
// continues rather than dead-ends.
//
// ⚠ The grant is matched on the exact path. No prefixes, no folders, no
// "approve all" — approval of one file is approval of one file.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/filebody"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/share"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/tenanturl"
	"github.com/brf-tech/filex/backend/internal/trash"
	"github.com/brf-tech/filex/backend/internal/versioning"
)

// Ceilings the tools apply. They are about the model's attention, not about
// the server's capacity: a listing of a thousand rows costs a hundred kilobytes
// of context and buys nothing over the first two hundred, and the answer the
// person is waiting for gets worse as the window fills.
const (
	assistantListDefault = 200
	assistantReadBytes   = 20_000
	assistantSearchLimit = 50
)

// AssistantToolDeps is what the file tools need. Everything is optional in the
// sense that a nil field disables the tools that use it rather than panicking —
// an installation without a search index still lists and reads.
type AssistantToolDeps struct {
	Store    db.Store
	Resolver func(int64) (storage.Driver, error)
	ACL      *acl.Resolver
	Index    *search.Index
	Body     *filebody.Resolver
	// The three services behind the operations that CHANGE something. Each is
	// nil-checked where it is used: a deployment without one is missing that
	// operation, not broken.
	Versions *versioning.Service
	Share    *share.Service
	Trash    *trash.Service
	// Tenants turns a request into the origin a minted /s/ link lives on. A
	// share link is only useful as an absolute URL, and which origin that is
	// depends on the host the person is on.
	Tenants tenanturl.Resolver
}

// assistantTools is one conversation's toolbox. It is built per turn, because
// the session id is half of every permission question it asks — and again to
// execute an approved plan, for the same reason.
type assistantTools struct {
	ops       *aiOps
	index     *search.Index
	store     db.Store
	acl       *acl.Resolver
	versions  *versioning.Service
	share     *share.Service
	trash     *trash.Service
	sessionID int64
	// origin is the base a minted share URL is built on. Set only when a plan
	// is EXECUTED, because that is the only moment a request is in hand and
	// the only moment a link exists; empty while the model is merely proposing.
	origin string
}

// newAssistantTools binds the file surface to one conversation.
func newAssistantTools(deps AssistantToolDeps, sessionID int64) *assistantTools {
	ops := newAIOps(deps.Store, deps.Resolver, deps.Share, "", nil)
	ops.acl = deps.ACL
	ops.attachSearchIndex(deps.Index)
	if deps.Body != nil {
		ops.attachBody(deps.Body)
	}
	return &assistantTools{
		ops: ops, index: deps.Index, store: deps.Store, acl: deps.ACL,
		versions: deps.Versions, share: deps.Share, trash: deps.Trash,
		sessionID: sessionID,
	}
}

// resolveNode turns an address into the cached node row every write operation
// is addressed by. It goes through resolveStorage first, so a path the caller
// may not even see never gets as far as a lookup.
func (t *assistantTools) resolveNode(ctx context.Context, path string) (*model.Node, error) {
	storage, rel, err := t.ops.resolveStorage(ctx, path)
	if err != nil {
		return nil, err
	}
	if rel == "" {
		return nil, fmt.Errorf("%s is a drive, not a file", path)
	}
	node, err := t.store.GetNodeByPath(ctx, storage.ID, pathkey.Hash(storage.ID, rel))
	if err != nil || node == nil {
		return nil, fmt.Errorf("filex has no record of %s yet — list the folder it is in first", path)
	}
	if node.DeletedAt != nil {
		return nil, fmt.Errorf("%s is in the trash", path)
	}
	return node, nil
}

// Specs describes the tools to the model.
//
// The descriptions are written for a reader who will otherwise guess: what a
// path looks like, that listing is cheap and reading is not, and that reading
// needs the person's permission for that one file.
func (t *assistantTools) Specs() []assistant.ToolSpec {
	return []assistant.ToolSpec{
		{
			Name:        "list_storages",
			Description: "List the drives this person has. Every path is written `<drive>://<folder>/<file>`, so start here when you do not know the drive names.",
			Schema:      object(nil, nil),
		},
		{
			Name:        "list_folder",
			Description: "List one folder's entries: names, types, sizes and dates. No file contents. This is the cheap way to look around, so prefer it.",
			Schema: object(map[string]any{
				"path":  str("The folder, as `<drive>://<path>`. Use `<drive>://` for the drive's root."),
				"limit": num(fmt.Sprintf("How many entries to return (default %d, maximum %d).", assistantListDefault, assistant.MaxFilesPerListing)),
			}, []string{"path"}),
		},
		{
			Name:        "search_files",
			Description: "Search one drive by name and, where filex has extracted it, by the text inside files. Name matching is forgiving: `.`, `-`, `_` and spaces are interchangeable. Content hits come back with a short snippet — that snippet is not permission to read the whole file.",
			Schema: object(map[string]any{
				"path":  str("The drive or folder to search in, as `<drive>://` or `<drive>://<folder>`."),
				"query": str("What to look for."),
			}, []string{"path", "query"}),
		},
		{
			Name:        "list_versions",
			Description: "List the stored revisions of one file, newest first, with their ids. Needed before proposing a restore.",
			Schema: object(map[string]any{
				"path": str("The file, as `<drive>://<path>`."),
			}, []string{"path"}),
		},
		{
			Name:        "list_shares",
			Description: "List the public links that exist on one file or folder, with their ids. Needed before proposing to revoke one.",
			Schema: object(map[string]any{
				"path": str("The file or folder, as `<drive>://<path>`."),
			}, []string{"path"}),
		},
		{
			Name:        "list_trash",
			Description: "List what is in the person's trash, with sizes and deletion dates. Deleted items can still be restored from the Trash page — until the trash is emptied, which destroys them.",
			Schema:      object(nil, nil),
		},
		{
			Name:        "plan_tags",
			Description: "PROPOSE tagging files. This does not tag anything: it writes a plan the person sees and approves, and the server applies it. Tags are added, never replaced. Say what you propose in one sentence and then wait.",
			Schema: object(map[string]any{
				"paths":   arr("The files to tag, each as `<drive>://<path>`.", str("")),
				"tags":    arr("The tags to add.", str("")),
				"summary": str("One sentence describing the plan, for the person to read."),
			}, []string{"paths", "tags", "summary"}),
		},
		{
			Name:        "plan_restore_version",
			Description: "PROPOSE putting an older revision of a file back. Only when the person asked for that restore directly. The current contents are saved as a new revision first, so it is reversible. This does not restore anything by itself: the person approves the plan and the server does it.",
			Schema: object(map[string]any{
				"path":       str("The file, as `<drive>://<path>`."),
				"version_id": num("Which revision, from list_versions."),
				"summary":    str("One sentence describing the plan, for the person to read."),
			}, []string{"path", "version_id", "summary"}),
		},
		{
			Name:        "plan_create_share",
			Description: "PROPOSE creating a public link to a file or folder. Only when the person asked for it directly. Anyone holding the link can open it WITHOUT signing in, so this is the one action that reaches outside the installation — never propose it as a convenience or a step inside something else. This does not create anything by itself: the person approves the plan and the server does it, then shows them the link.",
			Schema: object(map[string]any{
				"path":    str("The file or folder to share, as `<drive>://<path>`."),
				"summary": str("One sentence describing the plan, for the person to read."),
			}, []string{"path", "summary"}),
		},
		{
			Name:        "plan_revoke_share",
			Description: "PROPOSE closing a public link. Only when the person asked for it directly. Anyone holding the link loses access. This does not revoke anything by itself: the person approves the plan and the server does it.",
			Schema: object(map[string]any{
				"path":     str("The shared file or folder, as `<drive>://<path>`."),
				"share_id": num("Which link, from list_shares."),
				"summary":  str("One sentence describing the plan, for the person to read."),
			}, []string{"path", "share_id", "summary"}),
		},
		{
			Name:        "plan_move",
			Description: "PROPOSE moving files and folders into one folder. Only when the person asked to move, sort or organise those items. The destination is created first if it does not exist yet (the folder above it must). Nothing is renamed and nothing is overwritten: a name already taken in the destination is skipped. This does not move anything by itself: the person approves the plan and the server does it. Say what you propose in one sentence and then wait.",
			Schema: object(map[string]any{
				"paths":   arr("The files and folders to move, each as `<drive>://<path>`, on the same drive as the destination.", str("")),
				"target":  str("The folder to move them into, as `<drive>://<path>`; `<drive>://` for the drive's root."),
				"summary": str("One sentence describing the plan, for the person to read."),
			}, []string{"paths", "target", "summary"}),
		},
		{
			Name:        "plan_empty_trash",
			Description: "PROPOSE destroying everything in the trash. ONLY when the person asked for exactly this, never as a tidy-up step inside anything else. It cannot be undone and there is no version history behind it. The plan lists every item that would be destroyed; the person approves it and the server does it.",
			Schema: object(map[string]any{
				"summary": str("One sentence describing the plan, for the person to read."),
			}, []string{"summary"}),
		},
		{
			Name:        "read_file",
			Description: "Read a text file's contents. REQUIRES the person's permission for that exact file: if they have not approved it, this returns a refusal and they are shown the request. Ask before you call it, prefer metadata, and never call it to work around a refusal.",
			Schema: object(map[string]any{
				"path":   str("The file, as `<drive>://<path>`."),
				"reason": str("Why you need the contents, in one short sentence. The person sees this when deciding."),
			}, []string{"path", "reason"}),
		},
	}
}

// Run executes one call. It never returns an error: see the note on
// assistant.Toolbox — a refusal or a missing folder is an answer the model has
// to read, not a transport failure that should abort the turn.
func (t *assistantTools) Run(ctx context.Context, call assistant.ToolCall) assistant.ToolOutcome {
	switch call.Name {
	case "list_storages":
		return t.listStorages(ctx)
	case "list_folder":
		return t.listFolder(ctx, call.Args)
	case "search_files":
		return t.searchFiles(ctx, call.Args)
	case "read_file":
		return t.readFile(ctx, call.Args)
	case "list_versions":
		return t.listVersions(ctx, call.Args)
	case "list_shares":
		return t.listShares(ctx, call.Args)
	case "list_trash":
		return t.listTrash(ctx)
	case "plan_tags":
		return t.planTags(ctx, call.Args)
	case "plan_restore_version":
		return t.planRestoreVersion(ctx, call.Args)
	case "plan_create_share":
		return t.planCreateShare(ctx, call.Args)
	case "plan_revoke_share":
		return t.planRevokeShare(ctx, call.Args)
	case "plan_empty_trash":
		return t.planEmptyTrash(ctx, call.Args)
	case "plan_move":
		return t.planMove(ctx, call.Args)
	}
	return failure("there is no tool called %q", call.Name)
}

type listFolderArgs struct {
	Path  string `json:"path"`
	Limit int    `json:"limit"`
}

type searchArgs struct {
	Path  string `json:"path"`
	Query string `json:"query"`
}

type readArgs struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// listStorages answers with the drives the caller can see — the same rule the
// drive switcher in the app is drawn from.
func (t *assistantTools) listStorages(ctx context.Context) assistant.ToolOutcome {
	info := t.ops.RootInfo(ctx)
	names := make([]map[string]any, 0, len(info.Storages))
	for _, name := range info.Storages {
		names = append(names, map[string]any{"name": name, "root": name + "://"})
	}
	return payload(map[string]any{"storages": names})
}

func (t *assistantTools) listFolder(ctx context.Context, raw string) assistant.ToolOutcome {
	var args listFolderArgs
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	limit := args.Limit
	if limit <= 0 {
		limit = assistantListDefault
	}
	if limit > assistant.MaxFilesPerListing {
		limit = assistant.MaxFilesPerListing
	}
	entries, err := t.ops.List(ctx, args.Path)
	if err != nil {
		return failure("%v", err)
	}
	entries = withoutBookkeeping(entries)
	out := map[string]any{"path": args.Path, "count": len(entries)}
	if len(entries) > limit {
		// Truncation is REPORTED, not hidden. A model that thinks it saw the
		// whole folder will happily tell the person the file they asked about
		// is not there.
		out["truncated"] = true
		out["shown"] = limit
		entries = entries[:limit]
	}
	out["entries"] = entries
	return payload(out)
}

func (t *assistantTools) searchFiles(ctx context.Context, raw string) assistant.ToolOutcome {
	var args searchArgs
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	if strings.TrimSpace(args.Query) == "" {
		return failure("a search needs something to look for")
	}
	hits, err := mcpSearch(ctx, t.ops, t.index, args.Path, args.Query, true)
	if err != nil {
		return failure("%v", err)
	}
	if len(hits) > assistantSearchLimit {
		hits = hits[:assistantSearchLimit]
	}
	out := payload(map[string]any{"query": args.Query, "hits": hits})
	// The same rows again, this time for the panel to draw as cards. The model
	// reads them as JSON; the person gets something clickable, without waiting
	// for the answer to name every file in prose.
	if shown, err := json.Marshal(hits); err == nil {
		out.Hits = shown
	}
	return out
}

// readFile is the gated one.
func (t *assistantTools) readFile(ctx context.Context, raw string) assistant.ToolOutcome {
	var args readArgs
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	path := strings.TrimSpace(args.Path)
	if path == "" {
		return failure("which file?")
	}
	granted, err := t.store.AssistantReadGranted(ctx, t.sessionID, path)
	if err != nil {
		return failure("could not check the permissions for %s: %v", path, err)
	}
	if !granted {
		// The model is told plainly that this is not a bug to route around, and
		// the person gets a card naming the file and the stated reason.
		return assistant.ToolOutcome{
			Content: jsonString(map[string]any{
				"refused": "the person has not given permission to read this file",
				"path":    path,
				"next":    "tell them what you want to open and why, and wait. Do not try another path or tool to get at these contents.",
			}),
			Card: &assistant.Card{Kind: assistant.CardApproval, Path: path, Reason: strings.TrimSpace(args.Reason)},
		}
	}
	body, mime, err := t.ops.ReadBytes(ctx, path)
	if err != nil {
		return failure("%v", err)
	}
	text := string(body)
	if !utf8.ValidString(text) {
		// Handing a model the bytes of a JPEG spends the context window on
		// nothing and tells it nothing.
		return failure("%s is not a text file (%s); its contents cannot be read here", path, mime)
	}
	out := map[string]any{"path": path, "mime": mime}
	if len(text) > assistantReadBytes {
		text = text[:assistantReadBytes]
		out["truncated"] = true
		out["shown_bytes"] = assistantReadBytes
	}
	out["content"] = text
	return payload(out)
}

// assistantHiddenNames are filex's own bookkeeping, not the person's files:
// version snapshots and the e2e marker. The app's listing hides them, and the
// assistant showing them would be worse than untidy — it would invite the model
// to reason about, and offer to tidy up, a folder the person cannot even see.
// (aiOps.List already drops the trash and thumbnail folders.)
var assistantHiddenNames = map[string]bool{".versions": true, ".filex-e2e.json": true}

func withoutBookkeeping(entries []aiEntry) []aiEntry {
	out := entries[:0]
	for _, e := range entries {
		if assistantHiddenNames[e.Name] {
			continue
		}
		out = append(out, e)
	}
	return out
}

func (t *assistantTools) listVersions(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	if t.versions == nil {
		return failure("versioning is not available on this server")
	}
	node, err := t.resolveNode(ctx, args.Path)
	if err != nil {
		return failure("%v", err)
	}
	stored, err := t.versions.List(ctx, node.ID)
	if err != nil {
		return failure("%v", err)
	}
	out := make([]map[string]any, 0, len(stored))
	for _, v := range stored {
		out = append(out, map[string]any{
			"version_id": v.ID, "number": v.VersionN, "size": v.Size,
			"taken_at": v.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	return payload(map[string]any{"path": args.Path, "versions": out})
}

func (t *assistantTools) listShares(ctx context.Context, raw string) assistant.ToolOutcome {
	var args struct {
		Path string `json:"path"`
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
	links, err := t.share.ListByNode(ctx, node.ID)
	if err != nil {
		return failure("%v", err)
	}
	out := make([]map[string]any, 0, len(links))
	for _, sh := range links {
		// ⚠ The token is NOT reported. It is the credential itself: anyone
		// holding it can download the file, and there is no reason for it to
		// travel to a model provider. The id is enough to revoke by.
		out = append(out, map[string]any{
			"share_id": sh.ID, "created_at": sh.CreatedAt.UTC().Format(time.RFC3339),
			"downloads": sh.DownloadCount, "has_pin": sh.HasPin,
		})
	}
	return payload(map[string]any{"path": args.Path, "links": out})
}

func (t *assistantTools) listTrash(ctx context.Context) assistant.ToolOutcome {
	if t.trash == nil {
		return failure("the trash is not available on this server")
	}
	entries, total, err := t.trash.List(ctx, nil, true, db.NodeFacets{}, assistantListDefault, 0)
	if err != nil {
		return failure("%v", err)
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"path": e.StorageName + "://" + strings.TrimPrefix(e.Path, "/"),
			"name": e.Name, "size": e.Size,
			"deleted_at": e.DeletedAt.UTC().Format(time.RFC3339),
		})
	}
	return payload(map[string]any{"entries": out, "total": total})
}

// payload is a successful result: JSON, because a model reads structure more
// reliably than prose and the fields are what the answer is built from.
func payload(v map[string]any) assistant.ToolOutcome {
	return assistant.ToolOutcome{Content: jsonString(v)}
}

// failure is a result the model must react to — usually by telling the person
// or asking them something.
func failure(format string, args ...any) assistant.ToolOutcome {
	return assistant.ToolOutcome{Content: jsonString(map[string]any{"error": fmt.Sprintf(format, args...)})}
}

func jsonString(v map[string]any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return `{"error":"the result could not be encoded"}`
	}
	return string(raw)
}

// object / str / num build the JSON Schema both providers accept.
func object(properties map[string]any, required []string) map[string]any {
	if properties == nil {
		properties = map[string]any{}
	}
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func str(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func num(description string) map[string]any {
	return map[string]any{"type": "integer", "description": description}
}

func arr(description string, items map[string]any) map[string]any {
	return map[string]any{"type": "array", "description": description, "items": items}
}
