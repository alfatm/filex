package handlers

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/confine"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/filebody"
	"github.com/brf-tech/filex/backend/internal/httpx"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/protocolsync"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/thumb"
	"github.com/brf-tech/filex/backend/internal/writehook"
)

// Archive handles zip-listing, zip-extract, and zip-create operations.
//
// All zip ops materialize the source archive to a tmp file (since
// archive/zip needs an io.ReaderAt + Seeker), then stream extracts back
// to storage.
type Archive struct {
	Store           db.Store
	StorageResolver func(int64) (storage.Driver, error)
	ACL             *acl.Resolver
	// Body resolves where a member's bytes are: the driver, or filex's
	// staging area while a staged upload is still transferring. Nil-safe.
	Body *filebody.Resolver
	// Index and Thumbs feed the shared catalogue bookkeeper below. Both
	// optional.
	Index  *search.Index
	Thumbs *thumb.Pipeline
}

// AttachSearchIndex / AttachThumbs wire the two optional halves of the
// bookkeeper.
func (a *Archive) AttachSearchIndex(i *search.Index) { a.Index = i }

// AttachThumbs wires thumbnail generation for extracted members.
func (a *Archive) AttachThumbs(p *thumb.Pipeline) { a.Thumbs = p }

// sync returns the shared catalogue bookkeeper (internal/protocolsync) — row,
// search index, thumbnail, write hook and realtime change frame in one call.
//
// ⚠ Extract and Add wrote bytes to the driver and then did NOTHING ELSE: no
// node row, no index document, no event, no frame. The file existed on the
// storage and was invisible to every read path in filex until the next
// periodic sync walked the folder — which on an `ondemand` storage is never.
// Origin is "manager" because these two endpoints are the browser file
// manager's own Extract/Compress, reached from the SPA under a user session;
// they are not a new protocol.
func (a *Archive) sync() *protocolsync.Syncer {
	return protocolsync.New(a.Store, a.Index, a.Thumbs, writehook.OriginManager)
}

// storageRow fetches the storage record the bookkeeper needs. A miss returns
// nil and every caller degrades to "bytes written, catalogue not updated" —
// which is exactly the old behaviour, so a lookup failure cannot make things
// worse than they were.
func (a *Archive) storageRow(ctx context.Context, id int64) *model.Storage {
	st, err := a.Store.GetStorage(ctx, id)
	if err != nil {
		return nil
	}
	return st
}

// AttachBody wires the byte-source resolver so a file that is still being
// transferred can be zipped/extracted like any other.
func (a *Archive) AttachBody(b *filebody.Resolver) { a.Body = b }

// NewArchive constructs an Archive handler.
func NewArchive(store db.Store, resolver func(int64) (storage.Driver, error)) *Archive {
	return &Archive{Store: store, StorageResolver: resolver}
}

// AttachACL wires the RBAC resolver: list needs ≥viewer on the archive,
// extract/add need ≥editor on the write target (+ ≥viewer on sources read).
func (a *Archive) AttachACL(r *acl.Resolver) { a.ACL = r }

// archiveRequest is the union body for /api/files/archive/{list,extract,add}.
type archiveRequest struct {
	StorageID int64      `json:"storage_id"`
	Path      string     `json:"path"`
	Members   []string   `json:"members,omitempty"`
	DestDir   string     `json:"dest,omitempty"`
	Files     []addEntry `json:"files,omitempty"`
}

// addEntry is one source for /archive/add.
//
// Source is the path inside the storage to read from; Name is the
// destination path inside the zip.
type addEntry struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// archiveListEntry is the wire format for /archive/list responses.
type archiveListEntry struct {
	Name  string    `json:"name"`
	Size  int64     `json:"size"`
	Mtime time.Time `json:"mtime"`
	IsDir bool      `json:"is_dir"`
}

// List enumerates archive members.
func (a *Archive) List(w http.ResponseWriter, r *http.Request) {
	var req archiveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path"})
		return
	}
	storageID, rel, err := a.resolveStorage(r.Context(), req.StorageID, req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.StorageID = storageID
	req.Path = rel
	if !aclAllowID(r.Context(), a.ACL, a.Store, storageID, rel, acl.LevelViewer) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission"})
		return
	}
	tmp, err := a.fetchToTemp(r, req.StorageID, req.Path)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer os.Remove(tmp)

	zr, err := zip.OpenReader(tmp)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a zip: " + err.Error()})
		return
	}
	defer zr.Close()

	out := make([]archiveListEntry, 0, len(zr.File))
	for _, f := range zr.File {
		out = append(out, archiveListEntry{
			Name:  f.Name,
			Size:  int64(f.UncompressedSize64),
			Mtime: f.Modified,
			IsDir: strings.HasSuffix(f.Name, "/"),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out})
}

// Extract pulls members out of an archive into the destination directory.
//
// DestDir is interpreted on the SAME storage as the source. Members
// defaults to "all" when empty.
func (a *Archive) Extract(w http.ResponseWriter, r *http.Request) {
	var req archiveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path"})
		return
	}
	storageID, rel, err := a.resolveStorage(r.Context(), req.StorageID, req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.StorageID = storageID
	req.Path = rel
	drv, err := a.StorageResolver(req.StorageID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad storage"})
		return
	}
	writer, ok := drv.(storage.Writer)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "storage not writable"})
		return
	}

	tmp, err := a.fetchToTemp(r, req.StorageID, req.Path)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer os.Remove(tmp)

	zr, err := zip.OpenReader(tmp)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a zip: " + err.Error()})
		return
	}
	defer zr.Close()

	wanted := map[string]bool{}
	for _, m := range req.Members {
		wanted[m] = true
	}
	dest := req.DestDir
	if dest == "" {
		dest = path.Dir(req.Path)
	}
	dest = "/" + strings.TrimLeft(path.Clean("/"+dest), "/")

	// RBAC: reading the archive needs ≥viewer; extracting writes into dest → ≥editor.
	if !aclAllowID(r.Context(), a.ACL, a.Store, req.StorageID, strings.Trim(req.Path, "/"), acl.LevelViewer) ||
		!aclAllowID(r.Context(), a.ACL, a.Store, req.StorageID, strings.Trim(dest, "/"), acl.LevelEditor) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission"})
		return
	}

	mkdirer, _ := drv.(storage.Mkdirer)
	st := a.storageRow(r.Context(), req.StorageID)
	sy := a.sync()
	keys := make([]string, 0)
	// refused counts members the pre-write snapshot guard turned away, kept
	// distinct from every other `continue` in this loop. The other skips are
	// permanent and user-caused -- a zip-slip entry, a kind conflict -- and
	// retrying changes nothing. A guard refusal is transient and
	// system-caused (the object store is unreachable, say). Folding the two
	// together would answer 200 {"count":0,"keys":[]} for a wholesale outage,
	// with nothing telling the caller anything had gone wrong at all.
	refused := 0
	for _, f := range zr.File {
		if len(wanted) > 0 && !wanted[f.Name] && !wanted[strings.TrimSuffix(f.Name, "/")] {
			continue
		}
		safeRel, err := sanitizeZipPath(f.Name)
		if err != nil {
			slog.Warn("archive: skipped zip-slip entry", slog.String("name", f.Name), slog.String("err", err.Error()))
			continue
		}
		target := path.Join(dest, safeRel)
		// Defense in depth: ensure the joined target stays under dest.
		if !strings.HasPrefix(target+"/", strings.TrimRight(dest, "/")+"/") {
			slog.Warn("archive: target escapes dest after join", slog.String("target", target))
			continue
		}
		if strings.HasSuffix(f.Name, "/") {
			if mkdirer != nil {
				if kerr := storage.EnsureDirTarget(r.Context(), drv, target); kerr != nil {
					slog.Warn("archive: skipped folder colliding with a file",
						slog.String("target", target), slog.String("err", kerr.Error()))
					continue
				}
				_ = mkdirer.Mkdir(r.Context(), target)
				if st != nil {
					sy.Mkdir(r.Context(), st, target)
				}
			}
			continue
		}
		// An archive carrying both `X` and `X/y` would recreate the collision
		// this guard exists to stop — skip the member, extract the rest.
		if kerr := storage.EnsureFileTarget(r.Context(), drv, target); kerr != nil {
			slog.Warn("archive: skipped member colliding with a folder",
				slog.String("target", target), slog.String("err", kerr.Error()))
			continue
		}
		// The last moment at which the bytes this member is about to replace
		// still exist -- see writehook/overwrite.go. Counted in `refused`, not
		// folded into the permanent skips above.
		if kerr := writehook.BeforeOverwrite(r.Context(), req.StorageID, target); kerr != nil {
			slog.Warn("archive: skipped member refused: snapshot",
				slog.String("target", target), slog.String("err", kerr.Error()))
			refused++
			continue
		}
		rc, err := f.Open()
		if err != nil {
			slog.Warn("archive: zip member open", slog.String("name", f.Name), slog.String("err", err.Error()))
			continue
		}
		err = writer.Write(r.Context(), target, rc, int64(f.UncompressedSize64))
		_ = rc.Close()
		if err != nil {
			slog.Warn("archive: extract write", slog.String("target", target), slog.String("err", err.Error()))
			continue
		}
		if st != nil {
			sy.Write(r.Context(), st, target, int64(f.UncompressedSize64), mimeByExt(target))
		}
		keys = append(keys, target)
	}
	if len(keys) == 0 && refused > 0 {
		// Fail-closed at the batch level, mirroring every single-write guard
		// site: nothing landed, and it was refused rather than merely absent
		// from the archive. A 200 here would read as "there was nothing to
		// extract" when the truth is "the write layer refused everything".
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":   "could not preserve one or more existing files; nothing was written",
			"code":    "SNAPSHOT_FAILED",
			"refused": refused,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"keys":    keys,
		"count":   len(keys),
		"refused": refused,
	})
}

// Add packs members into a (new or existing) zip archive on the same storage.
//
// If the destination zip exists, we download it, append the new entries,
// then re-upload. Names are zip-slip protected on the read side.
func (a *Archive) Add(w http.ResponseWriter, r *http.Request) {
	var req archiveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.Path == "" || len(req.Files) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path or files"})
		return
	}
	storageID, rel, err := a.resolveStorage(r.Context(), req.StorageID, req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.StorageID = storageID
	req.Path = rel
	// Source paths in `Files[].Source` may also carry adapter prefixes —
	// strip them and assume same storage as the target archive.
	for i := range req.Files {
		_, srcRel := splitAdapterPath(req.Files[i].Source)
		if srcRel != "" {
			req.Files[i].Source = srcRel
		}
	}
	// RBAC: writing the archive needs ≥editor on the target; each source ≥viewer.
	if !aclAllowID(r.Context(), a.ACL, a.Store, req.StorageID, strings.Trim(req.Path, "/"), acl.LevelEditor) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission"})
		return
	}
	for _, f := range req.Files {
		if !aclAllowID(r.Context(), a.ACL, a.Store, req.StorageID, strings.Trim(f.Source, "/"), acl.LevelViewer) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission: " + f.Source})
			return
		}
	}
	drv, err := a.StorageResolver(req.StorageID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad storage"})
		return
	}
	writer, ok := drv.(storage.Writer)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "storage not writable"})
		return
	}

	// Try to fetch the existing zip — non-fatal if missing (we just create one).
	var existingMembers []*zip.File
	var existingTmp string
	if tmp, err := a.fetchToTemp(r, req.StorageID, req.Path); err == nil {
		existingTmp = tmp
		zr, zerr := zip.OpenReader(tmp)
		if zerr == nil {
			existingMembers = append(existingMembers, zr.File...)
			defer zr.Close()
		} else {
			slog.Warn("archive: existing zip unreadable, overwriting", slog.String("err", zerr.Error()))
		}
	}
	if existingTmp != "" {
		defer os.Remove(existingTmp)
	}

	// New tmp file we'll stream the rebuilt archive into.
	tmp, err := os.CreateTemp("", "filex-zip-add-*.zip")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	tmpName := tmp.Name()
	// Remove registered BEFORE Close so the defers unwind Close-then-Remove:
	// closed, then deleted, never the reverse. Every early return below
	// (zw.Close, tmp.Seek, EnsureFileTarget, BeforeOverwrite, writer.Write)
	// used to leak this fd -- only the success path closed it. The former
	// trailing `_ = tmp.Close()` is redundant with this and has been dropped.
	defer os.Remove(tmpName)
	defer tmp.Close()

	zw := zip.NewWriter(tmp)
	addedNames := map[string]bool{}
	for _, e := range req.Files {
		safe, err := sanitizeZipPath(e.Name)
		if err != nil {
			continue
		}
		src, err := a.Body.Resolve(r.Context(), drv, req.StorageID, e.Source, nil)
		if err != nil {
			slog.Warn("archive: source resolve", slog.String("source", e.Source), slog.String("err", err.Error()))
			continue
		}
		rc, err := src.Open(r.Context())
		if err != nil {
			slog.Warn("archive: source read", slog.String("source", e.Source), slog.String("err", err.Error()))
			continue
		}
		fw, err := zw.Create(safe)
		if err != nil {
			_ = rc.Close()
			continue
		}
		if _, err := io.Copy(fw, rc); err != nil {
			_ = rc.Close()
			slog.Warn("archive: copy member", slog.String("err", err.Error()))
			continue
		}
		_ = rc.Close()
		addedNames[safe] = true
	}
	for _, f := range existingMembers {
		if addedNames[f.Name] {
			continue // overwrite by name
		}
		fw, err := zw.CreateRaw(&f.FileHeader)
		if err != nil {
			continue
		}
		rc, err := f.OpenRaw()
		if err != nil {
			continue
		}
		_, _ = io.Copy(fw, rc)
	}
	if err := zw.Close(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	stat, _ := tmp.Stat()
	// Writing the archive onto an existing folder name would leave `X` and
	// `X/…` side by side on an object store (storage.ErrKindConflict).
	if err := storage.EnsureFileTarget(r.Context(), drv, req.Path); err != nil {
		writeJSON(w, mapDriverErr(err), map[string]string{"error": err.Error()})
		return
	}
	// The last moment at which the bytes this archive is about to replace
	// still exist -- see writehook/overwrite.go.
	if err := writehook.BeforeOverwrite(r.Context(), req.StorageID, req.Path); err != nil {
		slog.Warn("archive add refused: snapshot",
			slog.Int64("storage", req.StorageID),
			slog.String("path", req.Path),
			slog.String("err", err.Error()))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "could not preserve the existing file: " + err.Error(),
			"code":  "SNAPSHOT_FAILED",
		})
		return
	}
	if err := writer.Write(r.Context(), req.Path, tmp, stat.Size()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if st := a.storageRow(r.Context(), req.StorageID); st != nil {
		a.sync().Write(r.Context(), st, req.Path, stat.Size(), "application/zip")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path": req.Path,
		"size": stat.Size(),
	})
}

// resolveStorage takes the SFC's `path` (which may be either a bare
// relative path or `<adapter>://<rel>`) plus an optional `storage_id`
// and returns the resolved (storage_id, relative_path) pair.
//
// Order of precedence:
//  1. Explicit `storage_id` in the body (legacy embed.js).
//  2. `<adapter>://` prefix on `path`.
//  3. Fall back to storages[0].
func (a *Archive) resolveStorage(ctx context.Context, explicitID int64, fullPath string) (int64, string, error) {
	adapter, rel := splitAdapterPath(fullPath)
	if explicitID > 0 {
		return explicitID, strings.Trim(rel, "/"), nil
	}
	storages, err := a.Store.ListEnabledStorages(ctx)
	if err != nil {
		return 0, "", err
	}
	if len(storages) == 0 {
		return 0, "", errors.New("no storages configured")
	}
	if adapter == "" {
		adapter = storages[0].Name
	}
	for _, s := range storages {
		if s.Name == adapter {
			return s.ID, strings.Trim(rel, "/"), nil
		}
	}
	return 0, "", fmt.Errorf("unknown adapter: %s", adapter)
}

// fetchToTemp pulls a remote object into a local tmp file and returns the path.
func (a *Archive) fetchToTemp(r *http.Request, storageID int64, p string) (string, error) {
	drv, err := a.StorageResolver(storageID)
	if err != nil {
		return "", err
	}
	src, err := a.Body.Resolve(r.Context(), drv, storageID, p, nil)
	if err != nil {
		return "", err
	}
	rc, err := src.Open(r.Context())
	if err != nil {
		return "", err
	}
	defer rc.Close()
	tmp, err := os.CreateTemp("", "filex-arc-*.zip")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(tmp, rc); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	tmp.Close()
	return tmp.Name(), nil
}

// sanitizeZipPath enforces zip-slip protection.
//
// Rules:
//   - Replace backslashes (Windows-authored zips) with forward slashes
//   - Reject absolute paths (drive letters, leading "/")
//   - Reject any path that resolves to "..", "." escapes, or that contains
//     a literal ".." component
//   - Strip leading "./"
//
// Returns the cleaned RELATIVE path or an error.
func sanitizeZipPath(name string) (string, error) {
	if name == "" {
		return "", errors.New("empty entry name")
	}
	clean := strings.ReplaceAll(name, `\`, `/`)
	clean = strings.TrimPrefix(clean, "./")
	clean = strings.TrimLeft(clean, "/")
	if clean == "" {
		return "", errors.New("empty after sanitize")
	}
	// Drive letters (e.g. "C:foo") — uncommon but possible from Windows zips.
	if len(clean) >= 2 && clean[1] == ':' {
		return "", fmt.Errorf("absolute path: %q", name)
	}
	// Component check.
	for _, part := range strings.Split(clean, "/") {
		if part == ".." {
			return "", fmt.Errorf("parent traversal: %q", name)
		}
	}
	// Final clean — guarantees no "." segments.
	clean = strings.TrimLeft(path.Clean("/"+clean), "/")
	if clean == "" || strings.HasPrefix(clean, "..") {
		return "", fmt.Errorf("clean rejected: %q", name)
	}
	return clean, nil
}

// ── folder / multi-selection download ────────────────────────────────────────

// zipMaxRoots caps how many paths one download may name. It is a URL length
// guard as much as a server one: the paths ride in the query string.
const zipMaxRoots = 500

// zipMaxDepth stops a symlinked directory cycle from producing an endless
// stream. Nothing legitimate nests this deep.
const zipMaxDepth = 32

// zipRootName reserves a distinct archive name for one download root, adding a
// ` (2)`, ` (3)`, … before the extension when the plain basename is already
// spoken for. Deterministic: the suffix follows selection order.
//
// ⚠ A root is named after its basename, so a selection of `main://a/dup.txt`
// and `main://b/dup.txt` used to write TWO members called `dup.txt`. The format
// permits that and unpackers silently keep the last one, which turns
// "download everything I selected" — the ordinary move out of search results or
// the starred list, where a selection spans folders by construction — into a
// download that loses files without saying so. Nested members cannot collide
// (they carry the path below their root), so only the roots need this.
func zipRootName(name string, taken map[string]bool) string {
	candidate := name
	ext := path.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for n := 2; taken[candidate]; n++ {
		candidate = fmt.Sprintf("%s (%d)%s", stem, n, ext)
	}
	taken[candidate] = true
	return candidate
}

// DownloadZip streams a zip of the named paths — files, folders, or a mix.
//
//	GET /api/files/download/zip?path=main://Design&path=main://notes.md[&name=…]
//
// A GET with repeated `path` params, not a POST with a body, because the
// browser has to run this as a navigation to get its own save dialog, its own
// progress and its own disk write; a POST would mean holding the whole archive
// in the page's memory first.
//
// Everything that can be checked is checked BEFORE the first byte: once a zip
// header is on the wire the status is 200 for good, and a later failure can
// only cut the stream short. A read error deep inside a subtree is exactly that
// case — it ends the response and leaves the client with a short file, which is
// the honest outcome and the reason each root is stat'ed and authorised first.
func (a *Archive) DownloadZip(w http.ResponseWriter, r *http.Request) {
	paths := r.URL.Query()["path"]
	if len(paths) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path"})
		return
	}
	if len(paths) > zipMaxRoots {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "too many paths"})
		return
	}

	ctx := r.Context()
	type zipRoot struct {
		storageID int64
		rel       string
		// name is what this root is called INSIDE the archive: the basename, so a
		// selected folder arrives as "Design/…" rather than as the server's layout.
		name  string
		isDir bool
	}
	roots := make([]zipRoot, 0, len(paths))
	// A root is named after its basename, and two selected paths can share one:
	// `main://a/dup.txt` and `main://b/dup.txt`, two folders called `raw` under
	// different parents, two drives with the same name. See zipRootName.
	takenNames := make(map[string]bool, len(paths))
	for _, p := range paths {
		storageID, rel, err := a.resolveStorage(ctx, 0, p)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		// Naming an internal bucket as the download root would hand over
		// exactly what the walk below skips, so it is refused outright rather
		// than answered with an empty archive.
		if model.IsReservedPath(rel) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "internal path: " + p})
			return
		}
		if root, ok := confine.RootFrom(ctx); ok {
			st := a.storageRow(ctx, storageID)
			if st == nil || !root.Within(st.Name, rel) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "outside your root"})
				return
			}
		}
		if !aclAllowID(ctx, a.ACL, a.Store, storageID, rel, acl.LevelViewer) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission: " + p})
			return
		}
		drv, err := a.StorageResolver(storageID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad storage"})
			return
		}
		obj, err := drv.Stat(ctx, rel)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found: " + p})
			return
		}
		name := path.Base(strings.Trim(rel, "/"))
		if name == "" || name == "." {
			// A storage root has no basename of its own; the drive's name is the only one it has.
			if st := a.storageRow(ctx, storageID); st != nil {
				name = st.Name
			}
		}
		roots = append(roots, zipRoot{
			storageID: storageID, rel: rel,
			name:  zipRootName(name, takenNames),
			isDir: obj.Kind == storage.KindDirectory,
		})
	}

	filename := r.URL.Query().Get("name")
	if filename == "" {
		// One thing selected is named after it; a mixed selection has no name of its own.
		if len(roots) == 1 {
			filename = roots[0].name + ".zip"
		} else {
			filename = "files.zip"
		}
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", httpx.ContentDisposition("attachment", filename))
	// The size is unknowable without building the archive first, so this streams
	// chunked and the browser shows an indeterminate download.
	zw := zip.NewWriter(w)
	for _, rt := range roots {
		if err := a.zipInto(ctx, zw, rt.storageID, rt.rel, rt.name, rt.isDir, 0); err != nil {
			// The status line is long gone; all that is left is to stop writing.
			slog.Error("zip download aborted", slog.String("path", rt.rel), slog.String("err", err.Error()))
			return
		}
	}
	if err := zw.Close(); err != nil {
		slog.Error("zip download: close", slog.String("err", err.Error()))
	}
}

// zipInto writes one path into the archive, walking a folder depth-first.
//
// There is deliberately NO per-member permission check here, and there used to
// be one. It could never fire: grants are monotonic by prefix — Effective takes
// the best level over every grant whose PathPrefix CONTAINS the path
// (acl.prefixContains) — so a grant that covers a folder covers everything
// beneath it, and the root check in DownloadZip is the very same Effective call
// through aclAllowID. Once the root passes at viewer, no descendant can come
// out below it. Worse than merely dead, the branch implied a per-member
// guarantee the ACL model does not offer, and the walk must not be read as
// offering one: a selection is authorised as a whole BEFORE the first archive
// byte, because after the zip header the status is 200 for good and a mid-walk
// skip would ship a silently incomplete archive.
func (a *Archive) zipInto(ctx context.Context, zw *zip.Writer, storageID int64, rel, name string, isDir bool, depth int) error {
	// filex's own buckets (model.ReservedNames). This filter is live and it is
	// not an ACL question: on a storage with RBAC off `Effective` is just the
	// caller's role, so permissions alone let any account walk into the trash
	// and the version history. Walking the driver straight past the listing
	// projections is how a plain zip of a storage root came to carry other
	// people's deleted files and every snapshot ever taken.
	if model.IsReservedPath(rel) {
		return nil
	}
	if !isDir {
		return a.zipFile(ctx, zw, storageID, rel, name)
	}
	if depth >= zipMaxDepth {
		return nil
	}
	drv, err := a.StorageResolver(storageID)
	if err != nil {
		return err
	}
	entries, err := drv.List(ctx, rel)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		// An empty folder is part of what was selected; a zip records it as a name
		// ending in "/", and without this the folder would simply vanish.
		_, err := zw.Create(name + "/")
		return err
	}
	for _, e := range entries {
		child := path.Join(name, e.Name)
		// A symlink is zipped as the file it stands for, which is how every other
		// read path in filex treats one; only a real directory is walked.
		if err := a.zipInto(ctx, zw, storageID, e.Path, child, e.Kind == storage.KindDirectory, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// zipFile copies one object's bytes into the archive under `name`.
func (a *Archive) zipFile(ctx context.Context, zw *zip.Writer, storageID int64, rel, name string) error {
	drv, err := a.StorageResolver(storageID)
	if err != nil {
		return err
	}
	src, err := a.Body.Resolve(ctx, drv, storageID, rel, nil)
	if err != nil {
		return err
	}
	rc, err := src.Open(ctx)
	if err != nil {
		return err
	}
	defer rc.Close()
	fw, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.Copy(fw, rc)
	return err
}
