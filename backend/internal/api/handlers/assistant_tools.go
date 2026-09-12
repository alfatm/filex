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
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"strings"
	"time"
	"unicode/utf8"

	// The formats view_image can decode; registered by import, as image.Decode wants.
	_ "image/gif"
	_ "image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/assistant"
	"github.com/brf-tech/filex/backend/internal/confine"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/filebody"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/search/extract"
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
	// mode is the panel's chip for this turn — filename, content or tags —
	// and it binds search_files rather than advising the model: a hint in the
	// question was read as a suggestion, and the chip did nothing visible.
	mode string
	// ask puts an approval card in front of the person and returns their
	// decision — the turn handler sets it, because the turn is what holds
	// the stream the card goes out on. The tool call blocks on it: to the
	// model, permission is a slow read, not a conversation. Nil (no turn in
	// hand) leaves the old behaviour, a refusal carrying the card.
	ask func(ctx context.Context, card assistant.Card) string
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
		if node = t.catalogue(ctx, storage, rel); node == nil {
			return nil, fmt.Errorf("filex cannot find %s on %s", path, storage.Name)
		}
	}
	if node.DeletedAt != nil {
		return nil, fmt.Errorf("%s is in the trash", path)
	}
	return node, nil
}

// catalogue records a path the node cache has never seen but the storage
// really holds, and returns the row it wrote. nil means the driver has nothing
// there either — the only honest "it is not there".
//
// ⚠ The gap this closes: the assistant LISTS through the driver, while
// everything that changes a file is addressed by node id, and the rows in
// between are written by the periodic sync (15 minutes by default) or by a
// write filex made itself. So every file that was already on a storage when it
// was added reads fine and refuses to be tagged, restored, shared or moved
// until a walk gets to it — and the refusal used to tell the model to list the
// folder first, which writes no rows and could therefore never help.
//
// Rows only, through the same Syncer the protocol surfaces write through: this
// is discovery of something that is already there, so it must not announce
// itself as a write.
func (t *assistantTools) catalogue(ctx context.Context, drive *model.Storage, rel string) *model.Node {
	drv, err := t.ops.resolver(drive.ID)
	if err != nil {
		return nil
	}
	obj, err := drv.Stat(ctx, rel)
	if err != nil {
		return nil
	}
	syncer := t.ops.sync()
	if obj.Kind == storage.KindDirectory {
		if _, err := syncer.EnsureDirChain(ctx, drive, rel); err != nil {
			return nil
		}
	} else if _, _, ok := syncer.WriteRows(ctx, drive, rel, obj.Size, obj.Mime); !ok {
		return nil
	}
	node, err := t.store.GetNodeByPath(ctx, drive.ID, pathkey.Hash(drive.ID, rel))
	if err != nil {
		return nil
	}
	return node
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
			Description: "Read a file's contents as text: plain text and source files as they are; PDF, DOCX, XLSX and PPTX through text extraction. Not for images — read_image_text and view_image are. REQUIRES the person's permission for that exact file, and CALLING THIS IS HOW YOU ASK: the call shows them a card with the file, your reason and Allow / Deny buttons, waits for their answer, and returns the contents or a refusal. Do not ask in prose first. Prefer metadata, and never call it to work around a refusal.",
			Schema: object(map[string]any{
				"path":   str("The file, as `<drive>://<path>`."),
				"reason": str("Why you need the contents, in one short sentence. The person sees this when deciding."),
			}, []string{"path", "reason"}),
		},
		{
			Name:        "read_image_text",
			Description: "Extract the TEXT in an image (PNG, JPEG, WebP, TIFF) by OCR — a screenshot, a scanned page, a photo of a document. Returns the words, not what the picture shows; for that, view_image. Permission works exactly as for read_file: the call asks the person and waits.",
			Schema: object(map[string]any{
				"path":   str("The image, as `<drive>://<path>`."),
				"reason": str("Why you need the text, in one short sentence. The person sees this when deciding."),
			}, []string{"path", "reason"}),
		},
		{
			Name:        "view_image",
			Description: "LOOK at an image (PNG, JPEG, GIF, WebP): the picture is attached to the result for you to see — describe a photo, read a chart, check a design. Needs a model that accepts images. Permission works exactly as for read_file: the call asks the person and waits.",
			Schema: object(map[string]any{
				"path":   str("The image, as `<drive>://<path>`."),
				"reason": str("Why you need to see it, in one short sentence. The person sees this when deciding."),
			}, []string{"path", "reason"}),
		},
		{
			Name:        "write_report",
			Description: "Put a list of files, a search's results or a written report into a card the person can open and download as text or CSV. Use it instead of naming more than 20 files in an answer. Each path is resolved to the file's current name, size and date, so give only addresses you have seen; unknown ones are reported back as missing. This changes nothing and needs no approval. Afterwards name only the files that matter — do not repeat the list.",
			Schema: object(map[string]any{
				"title": str("What the report is, in a few words. It is the card's heading and the downloaded file's name."),
				"text":  str("The report itself, or a note above the list, in Markdown. Optional when there are paths."),
				"paths": arr("The files and folders to list, each as `<drive>://<path>`. Optional when there is text.", str("")),
			}, []string{"title"}),
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
	case "read_image_text":
		return t.readImageText(ctx, call.Args)
	case "view_image":
		return t.viewImage(ctx, call.Args)
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
	case "write_report":
		return t.writeReport(ctx, call.Args)
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

type reportArgs struct {
	Title string   `json:"title"`
	Text  string   `json:"text"`
	Paths []string `json:"paths"`
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
	query, withContent := args.Query, true
	switch t.mode {
	case "filename":
		withContent = false
	case "tags":
		query, withContent = asTagQuery(query), false
	}
	hits, err := mcpSearch(ctx, t.ops, t.index, args.Path, query, withContent)
	if err != nil {
		return failure("%v", err)
	}
	if len(hits) > assistantSearchLimit {
		hits = hits[:assistantSearchLimit]
	}
	result := map[string]any{"query": query, "hits": hits}
	if t.mode != "" {
		// Said back, so a search that found nothing is read as "nothing with
		// that tag" and not as "nothing by that name".
		result["scope"] = t.mode
	}
	out := payload(result)
	// The same rows again, this time for the panel to draw as cards. The model
	// reads them as JSON; the person gets something clickable, without waiting
	// for the answer to name every file in prose.
	if shown, err := json.Marshal(hits); err == nil {
		out.Hits = shown
	}
	return out
}

// writeReport puts a list of files, a search's results or a written report in
// front of the person as a card they can open and download. It is the way out
// of a long answer: the prompt caps how many files an answer may name, and
// everything past the cap goes here instead.
//
// The rows are resolved again rather than taken on trust: a path the model
// misremembered is reported back as missing, not written into a document the
// person will download as fact. Nothing here changes anything, so there is no
// plan and no approval.
func (t *assistantTools) writeReport(ctx context.Context, raw string) assistant.ToolOutcome {
	var args reportArgs
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return failure("could not read the arguments: %v", err)
	}
	args.Title = strings.TrimSpace(args.Title)
	args.Text = strings.TrimSpace(args.Text)
	if args.Title == "" {
		return failure("a report needs a title")
	}
	if len(args.Paths) == 0 && args.Text == "" {
		return failure("a report needs paths, text, or both")
	}
	result := map[string]any{"title": args.Title}
	if len(args.Paths) > assistant.MaxFilesPerListing {
		result["truncated"] = true
		args.Paths = args.Paths[:assistant.MaxFilesPerListing]
	}
	rows := make([]aiEntry, 0, len(args.Paths))
	var missing []string
	for _, p := range args.Paths {
		entry, err := t.ops.Info(ctx, p)
		if err != nil {
			missing = append(missing, p)
			continue
		}
		rows = append(rows, *entry)
	}
	report := map[string]any{"title": args.Title, "rows": rows}
	if args.Text != "" {
		report["text"] = args.Text
	}
	shown, err := json.Marshal(report)
	if err != nil {
		return failure("%v", err)
	}
	result["rows"] = len(rows)
	if len(missing) > 0 {
		result["missing"] = missing
	}
	result["note"] = "The report is in front of the person as a card they can open and download as text or CSV. Do not repeat its rows in the answer."
	out := payload(result)
	out.Report = shown
	return out
}

// asTagQuery reads every plain word of a query as a tag — `design invoices`
// becomes `tag:design tag:invoices` — for the Tags chip. A query that already
// names its tags is left alone.
func asTagQuery(query string) string {
	if parsed := search.ParseQuery(query); len(parsed.Tags) > 0 || len(parsed.ExcludeTags) > 0 {
		return query
	}
	words := search.NormWords(query)
	for i, w := range words {
		words[i] = "tag:" + w
	}
	return strings.Join(words, " ")
}

// permitRead is the gate every tool that opens a file's contents goes through:
// the path and reason from the call, the grant check, and the card when there
// is no grant yet. It returns the bytes and their mime type, or the outcome
// the model has to read instead — a refusal, a bad argument, a read error.
func (t *assistantTools) permitRead(ctx context.Context, raw string) (path string, body []byte, mime string, refused *assistant.ToolOutcome) {
	var args readArgs
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return "", nil, "", ptr(failure("could not read the arguments: %v", err))
	}
	path = strings.TrimSpace(args.Path)
	if path == "" {
		return "", nil, "", ptr(failure("which file?"))
	}
	granted, err := t.store.AssistantReadGranted(ctx, t.sessionID, path)
	if err != nil {
		return "", nil, "", ptr(failure("could not check the permissions for %s: %v", path, err))
	}
	if !granted {
		card := assistant.Card{Kind: assistant.CardApproval, Path: path, Reason: strings.TrimSpace(args.Reason)}
		if t.ask == nil {
			// The model is told plainly that this is not a bug to route
			// around, and the person gets a card naming the file and the
			// stated reason.
			return "", nil, "", &assistant.ToolOutcome{
				Content: jsonString(map[string]any{
					"refused": "the person has not given permission to read this file",
					"path":    path,
					"next":    "tell them what you want to open and why, and wait. Do not try another path or tool to get at these contents.",
				}),
				Card: &card,
			}
		}
		// The question is asked here and answered here: the call returns when
		// the person has pressed a button, or stopped answering. Either way the
		// model reads a result, never a "pending".
		switch t.ask(ctx, card) {
		case assistant.DecisionAllowed:
		case assistant.DecisionDenied:
			return "", nil, "", ptr(payload(map[string]any{
				"refused": "the person did not allow reading this file",
				"path":    path,
				"next":    "go on without its contents and do not ask for this file again. If the question cannot be answered without it, say so in one sentence.",
			}))
		default:
			return "", nil, "", ptr(payload(map[string]any{
				"refused": "the person did not answer the request in time",
				"path":    path,
				"next":    "go on without its contents. They can ask again when they are ready.",
			}))
		}
	}
	body, mime, err = t.ops.ReadBytes(ctx, path)
	if err != nil {
		return "", nil, "", ptr(failure("%v", err))
	}
	return path, body, mime, nil
}

func ptr(o assistant.ToolOutcome) *assistant.ToolOutcome { return &o }

// readFile is the gated one.
func (t *assistantTools) readFile(ctx context.Context, raw string) assistant.ToolOutcome {
	path, body, mime, refused := t.permitRead(ctx, raw)
	if refused != nil {
		return *refused
	}
	if strings.HasPrefix(mime, "image/") {
		return failure("%s is an image: read_image_text extracts the text in it, view_image lets you look at it", path)
	}
	text := string(body)
	out := map[string]any{"path": path, "mime": mime}
	// A PDF or an office document is read the way the search index reads it:
	// through the extractor for its format. A text file is handed over as it
	// is — the text extractor would only do the same, and it knows fewer
	// formats than a model can read. One past the cap, so the cut is noticed.
	if e := extract.For(mime, extensionOf(path)); e != nil && !strings.HasPrefix(mime, "text/") {
		var err error
		text, err = e.Extract(ctx, bytes.NewReader(body), int64(assistantReadBytes)+1)
		if err != nil {
			return failure("%s could not be read: %v", path, err)
		}
		if strings.TrimSpace(text) == "" {
			return failure("%s (%s) has no text to extract — a scanned document, an image, or empty", path, mime)
		}
		out["extracted_from"] = mime
	} else if !utf8.ValidString(text) {
		// Handing a model the bytes of a JPEG spends the context window on
		// nothing and tells it nothing.
		return failure("%s is not a text file (%s); its contents cannot be read here", path, mime)
	}
	if len(text) > assistantReadBytes {
		text = text[:assistantReadBytes]
		out["truncated"] = true
		out["shown_bytes"] = assistantReadBytes
	}
	out["content"] = text
	return payload(out)
}

// readImageText is OCR: the words in a picture, through the same tesseract
// extractor the search index uses — which is optional, and its absence is a
// plain answer rather than "no text found".
func (t *assistantTools) readImageText(ctx context.Context, raw string) assistant.ToolOutcome {
	path, body, mime, refused := t.permitRead(ctx, raw)
	if refused != nil {
		return *refused
	}
	if !strings.HasPrefix(mime, "image/") {
		return failure("%s is not an image (%s); read_file reads it", path, mime)
	}
	if extract.TesseractBin() == "" {
		return failure("OCR is not installed on this server (tesseract); view_image lets you look at %s instead", path)
	}
	e := extract.For(mime, extensionOf(path))
	if e == nil {
		return failure("%s (%s) is not a format OCR reads; view_image lets you look at it instead", path, mime)
	}
	text, err := e.Extract(ctx, bytes.NewReader(body), int64(assistantReadBytes)+1)
	if err != nil {
		return failure("%s could not be read: %v", path, err)
	}
	if strings.TrimSpace(text) == "" {
		return failure("no text was found in %s; view_image lets you look at it instead", path)
	}
	out := map[string]any{"path": path, "mime": mime, "ocr": true}
	if len(text) > assistantReadBytes {
		text = text[:assistantReadBytes]
		out["truncated"] = true
		out["shown_bytes"] = assistantReadBytes
	}
	out["content"] = text
	return payload(out)
}

// visionMaxEdge is the longest side a picture is sent at. Larger buys the
// model nothing it can use and costs context at every later turn.
const visionMaxEdge = 1568

// visionMaxPixels is the largest picture view_image will decode.
//
// ⚠⚠ It bounds an ALLOCATION, not a download. image.Decode builds the whole
// uncompressed frame before anything is scaled, and compression makes the two
// sizes unrelated: a 30000×30000 PNG of flat colour is a few hundred kilobytes
// on disk and gigabytes in memory, well inside the 8 MiB a read is capped at.
// Any account that can put a file in its own drive could ask the assistant to
// look at one and take the process down with it.
//
// 40 megapixels is 160 MB as 8-bit RGBA and 320 MB for a 16-bit PNG, which is
// survivable; it is also far above any photograph or scan somebody actually
// wants described, so the refusal costs nothing real.
const visionMaxPixels = 40_000_000

// viewImage hands the picture itself to the model, scaled to fit and
// re-encoded as JPEG so an 8 MiB photo does not travel as 8 MiB of base64.
func (t *assistantTools) viewImage(ctx context.Context, raw string) assistant.ToolOutcome {
	path, body, mime, refused := t.permitRead(ctx, raw)
	if refused != nil {
		return *refused
	}
	if !strings.HasPrefix(mime, "image/") {
		return failure("%s is not an image (%s); read_file reads it", path, mime)
	}
	// The header first. It is the only place the frame's size is known BEFORE
	// the memory for it is asked for — see visionMaxPixels. A refusal here is
	// a tool result the model reads and relays, not a failed request.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		return failure("%s (%s) could not be decoded as a picture: %v", path, mime, err)
	}
	if int64(cfg.Width)*int64(cfg.Height) > visionMaxPixels {
		return failure("%s says it is %d×%d, which is past the %d megapixels this can open; tell the person it is too large to look at and ask for a smaller copy if they need one described",
			path, cfg.Width, cfg.Height, visionMaxPixels/1_000_000)
	}
	src, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return failure("%s (%s) could not be decoded as a picture: %v", path, mime, err)
	}
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	fitted := src
	if longest := max(width, height); longest > visionMaxEdge {
		scaled := image.NewRGBA(image.Rect(0, 0, width*visionMaxEdge/longest, height*visionMaxEdge/longest))
		draw.CatmullRom.Scale(scaled, scaled.Bounds(), src, bounds, draw.Over, nil)
		fitted = scaled
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, fitted, &jpeg.Options{Quality: 85}); err != nil {
		return failure("%s could not be encoded for the model: %v", path, err)
	}
	out := payload(map[string]any{
		"path": path, "mime": mime, "width": width, "height": height,
		"note": "the picture is attached to this result; describe what you see in it",
	})
	out.Images = []assistant.Image{{Mime: "image/jpeg", Data: encoded.Bytes()}}
	return out
}

// extensionOf is the extension `extract.For` wants: after the last dot of the
// last segment, without the dot; "" when there is none.
func extensionOf(p string) string {
	name := p[strings.LastIndex(p, "/")+1:]
	if at := strings.LastIndex(name, "."); at >= 0 {
		return name[at+1:]
	}
	return ""
}

// withoutBookkeeping drops filex's own buckets (model.ReservedNames) from what
// the assistant sees. Showing them would be worse than untidy — it would invite
// the model to reason about, and offer to tidy up, a folder the person cannot
// even see. It knew two of the four names, and matched them as whole names only
// by luck of the spelling; the shared test is by path component, so a file the
// person called `my.thumbsup.png` stays visible.
func withoutBookkeeping(entries []aiEntry) []aiEntry {
	out := entries[:0]
	for _, e := range entries {
		if model.IsReservedPath(e.Name) {
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
	entries, _, err := t.trash.List(ctx, nil, true, db.NodeFacets{}, assistantTrashScan, 0)
	if err != nil {
		return failure("%v", err)
	}
	entries = t.ownTrash(ctx, entries)
	result := map[string]any{}
	if len(entries) > assistantListDefault {
		// Reported rather than hidden, the same as a truncated folder listing.
		result["truncated"] = true
		entries = entries[:assistantListDefault]
	}
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{
			"path": e.StorageName + "://" + strings.TrimPrefix(e.Path, "/"),
			"name": e.Name, "size": e.Size,
			"deleted_at": e.DeletedAt.UTC().Format(time.RFC3339),
		})
	}
	// The count is of what this person may see. `total` used to be the
	// service's own, which counted the whole installation's trash.
	result["entries"], result["total"] = out, len(out)
	return payload(result)
}

// assistantTrashScan is how deep into the installation-wide trash listing the
// two trash tools read before filtering it down to the person's own entries.
// The same page `POST /trash/empty` reads, and for the same reason: the rows
// that survive the filter are not the first rows of the query.
const assistantTrashScan = trashEmptyMax

// ownTrash is the person's trash, out of the installation's.
//
// ⚠⚠ trash.Service.List takes no user and filters nothing — it is the ADMIN
// listing, and both trash tools were handing it straight to the model. Paths,
// names and sizes of other people's deleted files went to the model provider,
// and `plan_empty_trash` counted its 50-item ceiling over all of them, so
// somebody with three deleted files of their own was refused for being over a
// limit they were nowhere near.
//
// The two passes are the ones `GET /api/files/manager/trash` applies, in the
// same order and on the same field: an entry's Path is its ORIGINAL path (the
// service prefers storage_key, which is where a soft-delete stashes it), not
// the `.filex-trash/…` key the row was renamed to.
func (t *assistantTools) ownTrash(ctx context.Context, entries []trash.TrashEntry) []trash.TrashEntry {
	kept := entries[:0]
	for _, e := range entries {
		// Confinement is read off the token here rather than off the request:
		// the assistant surface bypasses confine.Middleware, exactly as aiOps
		// does at its own chokepoint.
		if root, ok := confine.RootFromToken(ctx); ok && !root.Within(e.StorageName, e.Path) {
			continue
		}
		if !aclAllowName(ctx, t.acl, t.store, e.StorageName, e.Path, acl.LevelViewer) {
			continue
		}
		kept = append(kept, e)
	}
	return kept
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
