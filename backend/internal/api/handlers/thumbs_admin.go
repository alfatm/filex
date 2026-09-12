// Package handlers — thumbs_admin.go
//
// Admin thumbnail maintenance:
//
//	POST /api/admin/storages/{id}/thumbs/reset → one storage
//	POST /api/admin/thumbs/reset               → every storage
//
// Both answer 202 with {"cleared":N,"regenerating":true|false}: the rows and
// the cached JPEGs are gone by the time the response is written, and a
// background backfill is walking the same scope to rebuild them.
//
// # Why an admin needs this at all
//
// A thumbnail row in state="ready" is never re-run by a backfill, so a cache
// filled by an image that lacked the thumbnailer's tools (the `slim` image has
// none of ffmpeg / ghostscript / libreoffice) keeps serving the placeholder
// card it generated for every video, PDF and office document — for good, on an
// installation that has since moved to `full`. Dropping the rows is the only
// thing that gets a real preview onto the grid, and until this endpoint existed
// it meant hand-editing the `thumbnails` table.
package handlers

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/thumb"
)

// ThumbsAdmin serves the reset endpoints.
type ThumbsAdmin struct {
	Thumbs *thumb.Pipeline
	// Backfill re-dispatches the pipeline over the given storages (nil = all)
	// and RETURNS IMMEDIATELY, having handed the walk to a goroutine of its
	// own with a context that outlives this request. Nil when the server did
	// not wire it: the reset still happens, and the response says the
	// thumbnails are not being regenerated rather than claiming they are.
	Backfill func(storageIDs []int64)
}

// NewThumbsAdmin constructs the handler.
func NewThumbsAdmin(p *thumb.Pipeline, backfill func(storageIDs []int64)) *ThumbsAdmin {
	return &ThumbsAdmin{Thumbs: p, Backfill: backfill}
}

// ResetStorage clears one storage's thumbnails. POST /api/admin/storages/{id}/thumbs/reset
func (h *ThumbsAdmin) ResetStorage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad id"})
		return
	}
	h.reset(w, r, id)
}

// ResetAll clears every storage's thumbnails. POST /api/admin/thumbs/reset
func (h *ThumbsAdmin) ResetAll(w http.ResponseWriter, r *http.Request) {
	h.reset(w, r, 0)
}

// reset is the shared body. storageID 0 means the whole installation.
func (h *ThumbsAdmin) reset(w http.ResponseWriter, r *http.Request, storageID int64) {
	// No pipeline, or FILEX_THUMBS_ENABLED=false: the feature is off, so its
	// maintenance surface is off too. Clearing would work, but the answer
	// would have to say "cleared, and nothing is coming back" — an operator
	// who wants the disk space with thumbnails switched off is deleting the
	// cache directory, not driving the admin UI.
	if !h.Thumbs.Enabled() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "thumbnails disabled"})
		return
	}
	// ⚠ The request context, deliberately: the clearing is synchronous and the
	// count it returns is what the admin is told. A client that disconnects
	// mid-way aborts a maintenance action it can simply repeat — the operation
	// is idempotent — which is the right trade against holding a transaction
	// open for a caller that has gone away.
	cleared, err := h.Thumbs.Reset(r.Context(), storageID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	slog.Info("thumb reset",
		slog.Int64("storage", storageID),
		slog.Int("cleared", cleared),
		slog.Bool("regenerating", h.Backfill != nil))

	regenerating := false
	if h.Backfill != nil {
		var ids []int64
		if storageID > 0 {
			ids = []int64{storageID}
		}
		h.Backfill(ids)
		regenerating = true
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"cleared":      cleared,
		"regenerating": regenerating,
	})
}
