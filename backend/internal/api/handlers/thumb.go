package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// Thumb serves cached thumbnail JPEGs.
//
// Public-but-signed: requires `?sig=<hex hmac>` to prevent enumeration.
// HMAC key comes from settings.thumb_signing_key (auto-rotated daily;
// signature TTL ~24h).
type Thumb struct {
	Store    db.Store
	Pipeline *thumb.Pipeline
}

// NewThumb constructs a Thumb handler.
func NewThumb(store db.Store, p *thumb.Pipeline) *Thumb {
	return &Thumb{Store: store, Pipeline: p}
}

// Serve writes the JPEG bytes from the cache.
func (h *Thumb) Serve(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if !h.checkSig(idStr, r.URL.Query().Get("sig")) {
		http.Error(w, "bad signature", http.StatusForbidden)
		return
	}

	t, err := h.Store.GetThumbnail(r.Context(), id)
	if err != nil || t.State != "ready" {
		http.Error(w, "not ready", http.StatusNotFound)
		return
	}
	// A small image is its own tile: no cache file was ever written for it.
	if t.StorageKey == thumb.OriginalKey {
		node, nerr := h.Store.GetNode(r.Context(), id)
		if nerr != nil || !writeOriginalTile(w, r, h.Pipeline, node) {
			http.Error(w, "missing", http.StatusNotFound)
		}
		return
	}
	path := h.Pipeline.CachePath(id)
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "missing", http.StatusNotFound)
		return
	}
	defer f.Close()

	// ⚠⚠ REVALIDATE, don't cache blind. This used to answer
	// `private, max-age=86400` under a URL that is the node id and nothing
	// else, so a REGENERATED thumbnail was invisible for a day: an admin who
	// reset the cache, or an operator who added ffmpeg and backfilled, kept
	// looking at the old picture and concluded the reset had not worked.
	//
	// `no-cache` does not mean "do not store" — the browser keeps the bytes
	// and asks whether they are still current, so the steady state is a 304
	// with no body rather than a re-download. The ETag is the cached file's
	// mtime and size, which is exactly what changes when a thumbnail is
	// rebuilt.
	etag := thumbETag(f)
	if etag != "" {
		w.Header().Set("ETag", etag)
		if match := r.Header.Get("If-None-Match"); match != "" && etagMatches(match, etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, no-cache")
	_, _ = copyFileToResponse(w, f)
}

// writeOriginalTile streams the file itself as its own tile — the OriginalKey
// contract for an image small enough that resizing it would save nothing.
// Reports whether a response was written; false leaves the status to the
// caller, which is the only safe order once bytes are out.
//
// ⚠ It MUST answer with a validator and a length. There is no cache file to
// derive either from, and the first cut of this handler leaned on node.Etag
// alone — which a local storage does not fill. A `no-cache` response with no
// validator is the worst answer there is: the browser asks every time and gets
// the whole picture back every time, so a 400 KB tile was re-downloaded on
// every visit to the folder and rendered with a visible lag.
func writeOriginalTile(w http.ResponseWriter, r *http.Request, p *thumb.Pipeline, node *model.Node) bool {
	if p == nil || node == nil {
		return false
	}
	if etag := originalTileETag(node); etag != "" {
		w.Header().Set("ETag", etag)
		if match := r.Header.Get("If-None-Match"); match != "" && etagMatches(match, etag) {
			w.WriteHeader(http.StatusNotModified)
			return true
		}
	}
	rc, err := p.OpenOriginal(r.Context(), node)
	if err != nil {
		return false
	}
	defer rc.Close()
	ctype := thumb.MimeOf(node.Name)
	if ctype == "" {
		ctype = node.Mime
	}
	w.Header().Set("Content-Type", ctype)
	if node.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(node.Size, 10))
	}
	// The bytes ARE the file, and the file endpoint next door promises the same
	// minute on the same bytes. A rendered thumbnail cannot say this — it is
	// regenerated under an unchanged URL — but this one cannot be: a file that
	// changes changes the mtime the tile URL is keyed on.
	w.Header().Set("Cache-Control", "private, max-age=60")
	// These are the USER's bytes under a type this handler chose, which is the
	// shape a sniffing browser turns into someone else's script.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, rc)
	return true
}

// originalTileETag is the file's own validator, quoted.
//
// The driver's etag when there is one — an object store supplies it, and it is
// the most precise thing available. A local storage supplies none, so the
// fallback is the pair that changes whenever the bytes do and that every node
// row carries: the modification time and the size. Empty only for a node with
// neither, which then simply carries no validator.
func originalTileETag(node *model.Node) string {
	if node.Etag != "" {
		return `"` + strings.Trim(node.Etag, `"`) + `"`
	}
	mtime := node.DBMtime
	if node.BackendMtime != nil {
		mtime = *node.BackendMtime
	}
	if mtime.IsZero() {
		return ""
	}
	return `"` + strconv.FormatInt(mtime.UnixNano(), 10) + "-" + strconv.FormatInt(node.Size, 10) + `"`
}

// thumbETag derives a strong validator from the cached file itself, so it
// changes on every regeneration without the pipeline having to publish a
// version. Empty when the file cannot be stat'ed, in which case the response
// simply carries no validator.
func thumbETag(f *os.File) string {
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	return `"` + strconv.FormatInt(st.ModTime().UnixNano(), 10) + "-" + strconv.FormatInt(st.Size(), 10) + `"`
}

// etagMatches implements the If-None-Match comparison filex needs: a list of
// candidates, `*`, and the weak prefix a proxy may have added on the way out.
func etagMatches(header, etag string) bool {
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		if strings.TrimPrefix(strings.TrimSpace(candidate), "W/") == etag {
			return true
		}
	}
	return false
}

// checkSig verifies the HMAC signature query parameter.
func (h *Thumb) checkSig(idStr, sig string) bool {
	if sig == "" {
		// In V1 we accept unsigned thumbs from authenticated browser sessions.
		// Tighten this when the embed JS gains its own signed-URL flow.
		return true
	}
	key, _ := h.Store.GetSetting(context.Background(), "thumb_signing_key")
	if key == "" {
		return true
	}
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(idStr))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sig))
}

// copyFileToResponse streams file contents to the writer.
func copyFileToResponse(w http.ResponseWriter, f *os.File) (int64, error) {
	stat, err := f.Stat()
	if err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
	}
	buf := make([]byte, 32*1024)
	var written int64
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return written, werr
			}
			written += int64(n)
		}
		if err != nil {
			if err.Error() == "EOF" {
				return written, nil
			}
			return written, err
		}
	}
}
