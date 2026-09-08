// Package handlers — versions.go
//
// Endpoints under /api/files/versions.
//
//	GET    /api/files/versions?node_id=…             (auth)  list snapshots
//	POST   /api/files/versions/restore               (auth)  restore one
//	DELETE /api/files/versions/{id}                  (admin) hard delete
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/protocolsync"
	"github.com/brf-tech/filex/backend/internal/realtime"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/versioning"
)

// Versions wraps version-history HTTP routes.
type Versions struct {
	Store   db.Store
	Service *versioning.Service
	// Index keeps the restored content searchable. Optional; nil skips it.
	Index *search.Index
}

// AttachSearchIndex wires the search index. ⚠ Restoring a version rewrites the
// file's BYTES at an unchanged path, and nothing else ever revisits a
// document whose path did not change — so without this the index keeps the
// text of the version that was just rolled back. Measured: after restoring v1,
// a content search for a phrase only v2 ever contained still returned the
// file, and a phrase that IS in the restored file did not.
func (h *Versions) AttachSearchIndex(i *search.Index) { h.Index = i }

// NewVersions constructs the handler.
func NewVersions(store db.Store, svc *versioning.Service) *Versions {
	return &Versions{Store: store, Service: svc}
}

// List returns the version timeline for a node.
func (h *Versions) List(w http.ResponseWriter, r *http.Request) {
	nodeID, err := strconv.ParseInt(r.URL.Query().Get("node_id"), 10, 64)
	if err != nil || nodeID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad node_id"})
		return
	}
	versions, err := h.Service.List(r.Context(), nodeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	nameAuthors(r.Context(), h.Store, versions)
	writeJSON(w, http.StatusOK, map[string]any{
		"versions": versions,
		"node_id":  nodeID,
	})
}

type restoreReq struct {
	NodeID          int64 `json:"node_id"`
	VersionID       int64 `json:"version_id"`
	SnapshotCurrent bool  `json:"snapshot_current,omitempty"`
}

// snapshotReq is the POST /api/files/versions/snapshot body.
type snapshotReq struct {
	NodeID int64 `json:"node_id"`
}

// Snapshot records the node's current content as a new version on demand
// (the inspector's "take a version now" button; writes normally snapshot
// implicitly, this is the explicit user-triggered path).
func (h *Versions) Snapshot(w http.ResponseWriter, r *http.Request) {
	var req snapshotReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.NodeID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing fields"})
		return
	}
	v, err := h.Service.Snapshot(r.Context(), req.NodeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": v})
}

// Restore replaces the live content with a recorded version.
func (h *Versions) Restore(w http.ResponseWriter, r *http.Request) {
	var req restoreReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	if req.NodeID <= 0 || req.VersionID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing fields"})
		return
	}
	if err := h.Service.Restore(r.Context(), req.NodeID, req.VersionID, req.SnapshotCurrent); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	afterVersionRestore(r.Context(), h.Store, h.Index, req.NodeID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// afterVersionRestore is everything a restore owes the rest of the system:
// re-index the node, scan the bytes that just went live, and tell the open
// browsers. Shared with the assistant's plan executor, which restores through
// the same service — a second copy of this would be a second place to forget
// the antivirus step.
func afterVersionRestore(ctx context.Context, store db.Store, index *search.Index, nodeID int64) {
	if node, gerr := store.GetNode(ctx, nodeID); gerr == nil && node != nil {
		protocolsync.New(store, index, nil, "").IndexNode(ctx, node)
		// ⚠⚠ The bytes in `.versions/` were never scanned. queue's Eligible()
		// skips that prefix outright, deliberately: snapshotting is now what
		// every destructive write does, so scanning each snapshot would
		// multiply the scan load by the edit rate for bytes nobody can
		// execute. Restoring is the moment they become live again, and it is
		// rare — so the scan happens HERE. Without it, overwriting an
		// infected file with a clean one and then rolling back was a way to
		// put an infected file live on an install where every upload is
		// scanned.
		//
		// Asynchronous, exactly like an upload: the file is live and
		// unscanned until the verdict lands. That window is not a compromise
		// specific to restore — it is the same window every uploaded file
		// has, and the queue is what makes a slow scanner unable to stall a
		// write. Blocking here would make restore the one write surface in
		// filex that waits on ClamAV.
		enqueueAntivirusScan(ctx, node)
		emitFolderChange(node.StorageID, path.Dir(node.Path), realtime.ChangeEvent{
			Action: "upload", Name: node.Name,
		})
	}
}

// HardDelete erases a version row + its storage object (admin only).
func (h *Versions) HardDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	if err := h.Service.HardDeleteVersion(r.Context(), id); err != nil {
		msg := err.Error()
		if strings.Contains(msg, "no rows in result set") || strings.Contains(msg, "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "version not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// nameAuthors turns each revision's created_by into a name the panel can print.
//
// One lookup per DISTINCT author, not per revision: a file's history is capped
// at the retention count and is usually the work of one or two people. Rows
// written before the author was recorded keep no name, and the panel shows the
// revision without one rather than attributing it to whoever is looking.
func nameAuthors(ctx context.Context, store db.Store, versions []*model.NodeVersion) {
	if store == nil {
		return
	}
	names := map[int64]string{}
	for _, v := range versions {
		if v.CreatedBy == nil {
			continue
		}
		name, seen := names[*v.CreatedBy]
		if !seen {
			if u, err := store.GetUser(ctx, *v.CreatedBy); err == nil && u != nil {
				name = strings.TrimSpace(u.DisplayName)
				if name == "" {
					name = u.Email
				}
			}
			names[*v.CreatedBy] = name
		}
		v.AuthorName = name
	}
}
