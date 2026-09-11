// Package thumb generates and serves thumbnail images for nodes.
//
// The pipeline is dispatcher-based: GenerateThumb inspects the source
// node's mime type and routes to the appropriate generator (image / video
// / pdf / office). Each generator writes an output JPEG/PNG to the
// configured cache storage and updates the thumbnails table.
//
// Generators that require external binaries (ffmpeg, gs) detect availability
// up-front via the capability package and gracefully skip when not present.
// Office documents are the exception: their converter is normally a separate
// HTTP service (see AttachOfficeConverter), resolved per call because an admin
// can point filex at one without a restart.
package thumb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/e2e" /* wiring:e2 */
	"github.com/brf-tech/filex/backend/internal/filebody"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
)

// ErrSkipped is returned when no generator applies to the node — caller
// should mark the node's thumb state as "skipped" rather than "failed".
var ErrSkipped = errors.New("thumb: skipped")

// SmallImageBytes is the size under which a browser-renderable image is not
// re-encoded: the file itself IS its tile, so a 320px JPEG next to a 100 KB
// original would cost a render and a cache file to save nothing.
//
// ⚠ Bytes alone do NOT decide this — see fitsRawTile. Both limits must
// pass, because a file can be tiny on disk and enormous to decode.
const SmallImageBytes = 500 * 1024

// OriginalKey marks a thumbnail row whose picture IS the file: a small browser
// image, served byte for byte with no re-encode behind it. The row is `ready`
// like any other — what changes is where the bytes come from, so the serving
// side reads this instead of looking for a file in the cache directory.
//
// ⚠ These used to be written as `skipped`, which meant the listing carried no
// `thumb_url` at all for them and every client had to know the size rule and
// reconstruct the original's URL itself to show anything. A skipped row also
// reads as "there is no preview here" to the backfill and to the admin
// surfaces, which was never true of these files.
const OriginalKey = "original"

// Pipeline coordinates thumbnail generation.
type Pipeline struct {
	store    db.Store
	storages map[int64]storage.Driver
	cacheDir string
	// body resolves where a node's bytes are: the storage driver, or filex's
	// staging area while a staged upload is still transferring. Nil-safe.
	body *filebody.Resolver

	caps Capabilities
	// officeConverter answers the CURRENT office-service URL, empty when none
	// is configured. A function and not a string because the URL lives in
	// `external_services`, which an admin can edit while the server runs: a
	// value captured at boot would make "configure the office service" a
	// setting that needs a restart, which is the bug internal/external exists
	// to have removed.
	officeConverter func(context.Context) string
	// disabled is FILEX_THUMBS_ENABLED=false, and it is stored NEGATED on
	// purpose: the zero value has to mean "generate", or a caller that
	// constructs a pipeline without knowing about the switch (an embedder, a
	// test) would silently produce no thumbnails at all.
	disabled bool
}

// Disable turns generation off for the whole pipeline — the master switch
// behind FILEX_THUMBS_ENABLED, applied once at boot. Serving, the cache
// sweeper and the admin reset are unaffected: this is about not RENDERING.
func (p *Pipeline) Disable() { p.disabled = true }

// Enabled reports whether generation is on. Used by the surfaces that would
// otherwise promise work the pipeline will not do (the admin reset endpoints).
func (p *Pipeline) Enabled() bool { return p != nil && !p.disabled }

// AttachOfficeConverter wires the lookup for the remote office→PDF service.
// Optional: with no converter attached, office thumbnails need a local
// libreoffice, exactly as before.
func (p *Pipeline) AttachOfficeConverter(fn func(context.Context) string) { p.officeConverter = fn }

// officeUnavailableReason is the `skipped` reason written when a document
// arrives with nothing to convert it. It names both ways out, because the row
// it lands on is the only place an operator sees the problem.
const officeUnavailableReason = "no office converter (set FILEX_LIBREOFFICE_URL, or install libreoffice locally)"

// officeConvertURL is the configured office service, or empty when none is.
func (p *Pipeline) officeConvertURL(ctx context.Context) string {
	if p.officeConverter == nil {
		return ""
	}
	return strings.TrimSpace(p.officeConverter(ctx))
}

// officeReady reports whether office documents can be converted at all —
// either remotely or by a local binary.
func (p *Pipeline) officeReady(ctx context.Context) bool {
	return p.caps.Office || p.officeConvertURL(ctx) != ""
}

// AttachBody wires the byte-source resolver, so a file that is still being
// transferred gets its thumbnail from the staged bytes instead of failing
// against a driver that does not have the object yet.
func (p *Pipeline) AttachBody(b *filebody.Resolver) { p.body = b }

// openSource is the ONE door every generator reads its source bytes through.
// Generators must not call drv.Read directly — that is what made them blind to
// staged uploads, and a per-generator exception is how one file starts
// behaving differently depending on which thumbnailer picked it up.
func (p *Pipeline) openSource(ctx context.Context, drv storage.Driver, node *model.Node) (io.ReadCloser, error) {
	src, err := p.body.Resolve(ctx, drv, node.StorageID, node.Path, node)
	if err != nil {
		return nil, err
	}
	return src.Open(ctx)
}

// Capabilities indicates which thumbnail backends are available at runtime.
type Capabilities struct {
	Image  bool // always true (Go stdlib + bundled imaging)
	Video  bool // ffmpeg present in PATH
	Audio  bool // ffmpeg present (same binary handles audio waveform)
	PDF    bool // ghostscript or pdftoppm present
	Office bool // libreoffice/soffice present locally (a remote service is wired separately)
	SVG    bool // rsvg-convert present (vector→raster)
}

// New constructs a Pipeline.
func New(store db.Store, cacheDir string, caps Capabilities) *Pipeline {
	return &Pipeline{
		store:    store,
		storages: map[int64]storage.Driver{},
		cacheDir: cacheDir,
		caps:     caps,
	}
}

// AttachStorage registers a Driver for a storage ID — needed because the
// pipeline reads source bytes from the originating storage.
func (p *Pipeline) AttachStorage(id int64, drv storage.Driver) {
	p.storages[id] = drv
}

// GenerateThumb dispatches based on node MIME and updates the thumbnails
// row. Idempotent — safe to call repeatedly.
//
// Falls back to the file extension when `node.Mime` is empty — this is
// the common case for files discovered by sync's driver.List, where
// most drivers don't populate the mime field. Without the fallback every
// synced file got `state=skipped` and the pipeline never produced a
// thumbnail for the demo fixtures.
func (p *Pipeline) GenerateThumb(ctx context.Context, node *model.Node) error {
	if node == nil || node.Type != model.NodeTypeFile {
		return ErrSkipped
	}
	// ⚠ No row is written when generation is off. A "skipped" row here would
	// outlive the switch: turning thumbnails back on would need a backfill
	// with --retry-skipped before a single tile appeared. With no row at all,
	// the next backfill (or the next upload) simply generates.
	if p.disabled {
		return ErrSkipped
	}
	drv, ok := p.storages[node.StorageID]
	if !ok {
		return errors.New("thumb: no driver attached for storage")
	}
	/* wiring:e2 — files under an E2E-encrypted folder are ciphertext the
	   server cannot (and must not try to) render: skip before any byte is
	   read. Wasted CPU aside, a plaintext file mistakenly written into an
	   encrypted subtree via DAV/CLI would otherwise leak a readable thumb.
	   Upsert (not SetState — that is UPDATE-only) so the skip records even
	   though the pending row was never created. */
	if e2e.UnderEncrypted(ctx, p.store, node.StorageID, node.Path) {
		_ = p.store.UpsertThumbnail(ctx, &model.Thumbnail{
			NodeID: node.ID, State: "skipped", Error: "e2e-encrypted folder",
		})
		return ErrSkipped
	}
	/* /wiring:e2 */
	t := &model.Thumbnail{NodeID: node.ID, State: "pending"}
	_ = p.store.UpsertThumbnail(ctx, t)

	// ⚠⚠ The EXTENSION wins over the catalogued MIME for every kind this
	// dispatcher routes on, not just for the rows that have no MIME at all.
	//
	// The catalogue's MIME is sniffed from the first 512 bytes, and an SVG has
	// no magic number — so every .svg on a local storage is stored as
	// text/plain, matched NEITHER svg branch below, and fell through to the
	// generic placeholder card: a green rectangle with "SVG" on it, in
	// state="ready", on an install with librsvg sitting right there. Sniffing
	// is now repaired at the source too (storage.RefineMime), but a row
	// catalogued before that stays wrong until its file changes, and the
	// thumbnail must not depend on a re-sync to be right.
	//
	// The stored MIME still decides for everything mimeFromName does not know
	// — an image/* that S3 metadata supplied for an extensionless object, say.
	mime := strings.ToLower(node.Mime)
	if byExt := mimeFromName(node.Name); byExt != "" {
		mime = byExt
	}
	// Probed once, not per branch: the header read is cheap but it is still a
	// read of the file, and two of the cases below ask the same question.
	animatedWebP := mime == "image/webp" && p.webpAnimated(ctx, drv, node)
	var err error
	switch {
	// SVG must come BEFORE the generic image/* branch — Go's stdlib
	// image.Decode can't parse SVG, so the regular generateImage
	// would fail with "unknown format". Route SVGs to rsvg-convert
	// when it's available, otherwise skip cleanly.
	case mime == "image/svg+xml" && p.caps.SVG:
		err = p.generateSVG(ctx, node, drv)
	case mime == "image/svg+xml":
		_ = p.store.SetThumbnailState(ctx, node.ID, "skipped", "rsvg-convert not in PATH")
		return ErrSkipped
	// Animated WebP first, at ANY size: the image generator cannot decode one
	// at all (see animated.go), so without this branch every animated WebP on
	// the installation records a decode failure instead of a picture.
	case animatedWebP && p.caps.Video:
		err = p.generateAnimatedWebP(ctx, node, drv)
	case animatedWebP:
		_ = p.store.SetThumbnailState(ctx, node.ID, "skipped", animatedWebPReason)
		return ErrSkipped
	// A still image small enough to stand as its own tile: the row goes ready
	// with the ORIGINAL bytes behind it — no re-encode, no cache file, nothing
	// resized. An animated GIF is the exception: served as-is it would play in
	// the listing, so it goes to the image generator, whose gif.Decode hands
	// back the first frame.
	case isBrowserImage(mime) && node.Size > 0 && node.Size < SmallImageBytes:
		// Small in bytes is not small to decode. See fitsRawTile.
		if !p.fitsRawTile(ctx, drv, node) {
			err = p.generateImage(ctx, node, drv)
			break
		}
		if mime == "image/gif" && p.gifAnimated(ctx, drv, node) {
			err = p.generateImage(ctx, node, drv)
			break
		}
		now := time.Now()
		_ = p.store.UpsertThumbnail(ctx, &model.Thumbnail{
			NodeID: node.ID, State: "ready", StorageKey: OriginalKey, GeneratedAt: &now,
		})
		return nil
	case strings.HasPrefix(mime, "image/"):
		err = p.generateImage(ctx, node, drv)
	case strings.HasPrefix(mime, "video/") && p.caps.Video:
		err = p.generateVideo(ctx, node, drv)
	case strings.HasPrefix(mime, "audio/") && p.caps.Audio:
		err = p.generateAudio(ctx, node, drv)
	case mime == "application/pdf" && p.caps.PDF:
		err = p.generatePDF(ctx, node, drv)
	case isOfficeMime(mime) && p.officeReady(ctx):
		err = p.generateOffice(ctx, node, drv)
	// ⚠⚠ A kind filex CAN render, whose tool is not installed, skips — it does
	// NOT fall through to the placeholder card below. The card was worse than
	// nothing twice over: every client already draws its own per-type artwork
	// (better art, and it knows the viewport), and the card is written as
	// state="ready", the one state a backfill never re-runs. So an install
	// that ran once without ffmpeg kept a green rectangle where a video frame
	// belongs FOREVER, including after moving to the full image. Skipped rows
	// are the recoverable state: `filex thumb backfill --retry-skipped`.
	case strings.HasPrefix(mime, "video/"):
		_ = p.store.SetThumbnailState(ctx, node.ID, "skipped", "ffmpeg not in PATH")
		return ErrSkipped
	case strings.HasPrefix(mime, "audio/"):
		_ = p.store.SetThumbnailState(ctx, node.ID, "skipped", "ffmpeg not in PATH")
		return ErrSkipped
	case mime == "application/pdf":
		_ = p.store.SetThumbnailState(ctx, node.ID, "skipped", "no PDF renderer (gs / pdftoppm) in PATH")
		return ErrSkipped
	case isOfficeMime(mime):
		_ = p.store.SetThumbnailState(ctx, node.ID, "skipped", officeUnavailableReason)
		return ErrSkipped
	default:
		// Kinds filex has NO generator for (3D models, archives, code,
		// markdown, raw docs, …) get a deterministic placeholder card so a
		// grid with no artwork of its own still shows something legible.
		// Cheap — pure Go image stdlib, no external binary.
		//
		// Reached only when no generator exists for the type: a missing TOOL
		// skips above instead, so a card can no longer stand in for a preview
		// that this install is one `apk add` away from rendering properly.
		err = p.generateGeneric(ctx, node)
	}
	if err != nil {
		_ = p.store.SetThumbnailState(ctx, node.ID, "failed", err.Error())
		// Report the PATH, not just the node id. A decode failure almost always
		// means the stored bytes are damaged, and the next question is always
		// "which file?" — with only a node id that costs a manual lookup in the
		// catalogue database before the investigation can even start.
		slog.Warn("thumb generate failed",
			slog.Int64("node", node.ID),
			slog.String("path", node.Path),
			slog.Int64("size", node.Size),
			slog.String("mime", mime),
			slog.String("err", err.Error()))
		return err
	}
	now := time.Now()
	_ = p.store.UpsertThumbnail(ctx, &model.Thumbnail{
		NodeID:      node.ID,
		State:       "ready",
		StorageKey:  fmt.Sprintf("%s/%d.jpg", p.cacheDir, node.ID),
		GeneratedAt: &now,
	})
	return nil
}

// CachePath returns the disk path where a thumb is stored for node ID.
func (p *Pipeline) CachePath(nodeID int64) string {
	return fmt.Sprintf("%s/%d.jpg", p.cacheDir, nodeID)
}

// OpenOriginal opens the bytes behind an OriginalKey row — the file itself,
// which for a small image is what the thumbnail endpoints stream. Same door as
// every generator reads through, so a file still being transferred serves from
// the staging area rather than 404ing against a driver that has nothing yet.
func (p *Pipeline) OpenOriginal(ctx context.Context, node *model.Node) (io.ReadCloser, error) {
	if p == nil || node == nil {
		return nil, errors.New("thumb: no node")
	}
	drv, ok := p.storages[node.StorageID]
	if !ok {
		return nil, errors.New("thumb: no driver attached for storage")
	}
	return p.openSource(ctx, drv, node)
}

// MimeOf is the pipeline's extension→MIME table, for the serving side: an
// OriginalKey tile answers with the file's own type, and that decision has to
// come from the same table the dispatcher routed on rather than a second copy
// of it. Empty for a name the pipeline has no opinion about.
func MimeOf(name string) string { return mimeFromName(name) }

// mimeFromName picks a thumbnail-pipeline-relevant MIME class from the
// file extension. This is INTENTIONALLY narrow — the pipeline only
// branches on image/* / video/* / application/pdf / office mime, so
// other extensions can stay empty and skip cleanly.
func mimeFromName(name string) string {
	dot := strings.LastIndex(name, ".")
	if dot < 0 {
		return ""
	}
	ext := strings.ToLower(name[dot+1:])
	switch ext {
	case "jpg", "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "bmp":
		return "image/bmp"
	case "svg":
		return "image/svg+xml"
	case "heic":
		return "image/heic"
	case "avif":
		return "image/avif"
	case "tiff", "tif":
		return "image/tiff"
	case "mp3":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "ogg":
		return "audio/ogg"
	case "flac":
		return "audio/flac"
	case "m4a":
		return "audio/mp4"
	case "aac":
		return "audio/aac"
	case "opus":
		return "audio/opus"
	case "mp4":
		return "video/mp4"
	case "webm":
		return "video/webm"
	case "mov":
		return "video/quicktime"
	case "mkv":
		return "video/x-matroska"
	case "avi":
		return "video/x-msvideo"
	case "ogv":
		return "video/ogg"
	case "m4v":
		return "video/mp4"
	case "pdf":
		return "application/pdf"
	case "doc":
		return "application/msword"
	case "docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "xls":
		return "application/vnd.ms-excel"
	case "xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case "ppt":
		return "application/vnd.ms-powerpoint"
	case "pptx":
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	case "odt":
		return "application/vnd.oasis.opendocument.text"
	case "ods":
		return "application/vnd.oasis.opendocument.spreadsheet"
	case "odp":
		return "application/vnd.oasis.opendocument.presentation"
	case "rtf":
		return "application/rtf"
	}
	return ""
}

// isBrowserImage names the formats every browser renders in an <img>, which
// is what makes the original usable as its own tile under SmallImageBytes.
// TIFF, HEIC and the rest still need a thumbnail whatever their size.
func isBrowserImage(m string) bool {
	switch m {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}

func isOfficeMime(m string) bool {
	switch m {
	case "application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/vnd.oasis.opendocument.text",
		"application/vnd.oasis.opendocument.spreadsheet",
		"application/vnd.oasis.opendocument.presentation":
		return true
	}
	return false
}
