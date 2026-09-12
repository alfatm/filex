package thumb_test

// What the dispatcher does when it CANNOT render a file, which is the whole
// difference between a grid that degrades and one that lies:
//
//   - a kind filex has a generator for, whose tool is missing → "skipped",
//     never a placeholder card. The card was written as "ready", the one state
//     a backfill never re-runs, so it froze a green rectangle in place of a
//     video frame even after the tools arrived;
//   - a kind filex has no generator for at all → still a placeholder card, for
//     clients with no artwork of their own;
//   - the master switch off → no row at all, so turning it back on needs no
//     --retry-skipped to undo.

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil/dbtest"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// dispatchFixture wires a pipeline with NO external tools available — the
// `slim` image's runtime — over a local driver, so the dispatcher's decisions
// are what the test measures.
func dispatchFixture(t *testing.T, caps thumb.Capabilities) (db.Store, *thumb.Pipeline, int64) {
	t.Helper()
	ctx := context.Background()
	_, store := dbtest.NewTestDB(t)

	root := t.TempDir()
	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))

	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "s", Driver: "local", MountPath: "s", Enabled: true,
		ConfigJSON: []byte(`{}`),
	})
	require.NoError(t, err)

	p := thumb.New(store, t.TempDir(), caps)
	p.AttachStorage(st.ID, drv)
	return store, p, st.ID
}

func dispatchNode(t *testing.T, store db.Store, sid int64, name string) *model.Node {
	t.Helper()
	return dispatchNodeMime(t, store, sid, name, "")
}

// dispatchNodeMime is the same with a catalogued MIME, which is what a storage
// sync sniffs from the first 512 bytes — and gets wrong for markup.
func dispatchNodeMime(t *testing.T, store db.Store, sid int64, name, mime string) *model.Node {
	t.Helper()
	n, err := store.CreateNode(context.Background(), &model.Node{
		StorageID: sid, Name: name, Path: "/" + name, Mime: mime,
		PathHash: pathkey.Hash(sid, "/"+name), Type: model.NodeTypeFile, Size: 4096,
	})
	require.NoError(t, err)
	return n
}

// ⚠ The headline. Every one of these used to land as state="ready" with a
// tinted card on disk, permanently.
func TestGenerateThumb_MissingToolSkipsInsteadOfDrawingACard(t *testing.T) {
	ctx := context.Background()
	// Image only — exactly what the slim image can do.
	store, p, sid := dispatchFixture(t, thumb.Capabilities{Image: true})

	for _, tc := range []struct{ name, reason string }{
		{"clip.mp4", "ffmpeg not in PATH"},
		{"song.mp3", "ffmpeg not in PATH"},
		{"report.pdf", "no PDF renderer (gs / pdftoppm) in PATH"},
		{"sheet.xlsx", "no office converter (set FILEX_LIBREOFFICE_URL, or install libreoffice locally)"},
		{"vector.svg", "rsvg-convert not in PATH"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n := dispatchNode(t, store, sid, tc.name)

			err := p.GenerateThumb(ctx, n)
			require.ErrorIs(t, err, thumb.ErrSkipped)

			row, err := store.GetThumbnail(ctx, n.ID)
			require.NoError(t, err)
			require.Equal(t, "skipped", row.State)
			require.Equal(t, tc.reason, row.Error, "the row has to say which tool is missing")
			require.NoFileExists(t, p.CachePath(n.ID), "no placeholder card may be cached")
		})
	}
}

// The card survives where it is the only thing on offer: a kind with no
// generator at all.
func TestGenerateThumb_KindWithNoGeneratorStillGetsAPlaceholder(t *testing.T) {
	ctx := context.Background()
	store, p, sid := dispatchFixture(t, thumb.Capabilities{Image: true})
	n := dispatchNode(t, store, sid, "archive.zip")

	require.NoError(t, p.GenerateThumb(ctx, n))

	row, err := store.GetThumbnail(ctx, n.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.State)
	require.FileExists(t, p.CachePath(n.ID))
}

// A tool that IS present still renders: the skip branches must sit below the
// generator branches, not in front of them.
func TestGenerateThumb_WithToolsPresentStillDispatchesToTheGenerator(t *testing.T) {
	ctx := context.Background()
	// Video capability claimed without a real ffmpeg → the generator runs and
	// fails, which is the proof it was reached at all. "failed" is retryable
	// (`backfill --retry-failed`); "skipped" here would mean the wrong branch.
	store, p, sid := dispatchFixture(t, thumb.Capabilities{Image: true, Video: true})
	n := dispatchNode(t, store, sid, "clip.mp4")

	err := p.GenerateThumb(ctx, n)
	require.Error(t, err)
	require.NotErrorIs(t, err, thumb.ErrSkipped)

	row, err := store.GetThumbnail(ctx, n.ID)
	require.NoError(t, err)
	require.Equal(t, "failed", row.State)
}

// FILEX_THUMBS_ENABLED=false: nothing rendered, and — the part that matters —
// nothing recorded. A "skipped" row here would outlive the switch and need a
// --retry-skipped before the first tile appeared after turning it back on.
func TestGenerateThumb_DisabledWritesNoRowAtAll(t *testing.T) {
	ctx := context.Background()
	store, p, sid := dispatchFixture(t, thumb.Capabilities{Image: true})
	p.Disable()
	require.False(t, p.Enabled())

	n := dispatchNode(t, store, sid, "photo.png")
	require.ErrorIs(t, p.GenerateThumb(ctx, n), thumb.ErrSkipped)

	_, err := store.GetThumbnail(ctx, n.ID)
	require.Error(t, err, "no row, not even a skipped one")
	require.NoFileExists(t, p.CachePath(n.ID))
}

// ⚠ The one that took two rounds of resets to find. An SVG has no magic
// number, so a storage sync catalogues it as text/plain — and the dispatcher
// used to trust that MIME whenever it was non-empty. The file matched neither
// SVG branch, fell through to the generic card, and no reset could help:
// regeneration read the same wrong MIME and drew the same green rectangle.
func TestGenerateThumb_SVGCataloguedAsTextStillRoutesToTheSVGBranch(t *testing.T) {
	ctx := context.Background()

	// Without librsvg: the proof is the REASON on the skipped row — the SVG
	// branch names rsvg-convert, the generic card would have said nothing.
	store, p, sid := dispatchFixture(t, thumb.Capabilities{Image: true})
	n := dispatchNodeMime(t, store, sid, "logo.svg", "text/plain; charset=utf-8")

	require.ErrorIs(t, p.GenerateThumb(ctx, n), thumb.ErrSkipped)
	row, err := store.GetThumbnail(ctx, n.ID)
	require.NoError(t, err)
	require.Equal(t, "skipped", row.State)
	require.Equal(t, "rsvg-convert not in PATH", row.Error)
	require.NoFileExists(t, p.CachePath(n.ID), "no green card with SVG written on it")

	// With librsvg claimed present the generator is reached: it runs and fails
	// (there is no real rsvg-convert here), which is state=failed, not a card.
	store2, p2, sid2 := dispatchFixture(t, thumb.Capabilities{Image: true, SVG: true})
	n2 := dispatchNodeMime(t, store2, sid2, "logo.svg", "text/plain; charset=utf-8")

	require.Error(t, p2.GenerateThumb(ctx, n2))
	row2, err := store2.GetThumbnail(ctx, n2.ID)
	require.NoError(t, err)
	require.Equal(t, "failed", row2.State)
}

// A row whose MIME the extension knows nothing about keeps the catalogued
// one — an object store that supplied the type out of band still gets its
// image rendered.
func TestGenerateThumb_UnknownExtensionKeepsTheCataloguedMime(t *testing.T) {
	ctx := context.Background()
	store, p, sid := dispatchFixture(t, thumb.Capabilities{Image: true})
	n := dispatchNodeMime(t, store, sid, "photo-without-extension", "image/png")

	// Routed as an image, not to the placeholder card: the small-image branch
	// it lands on fires only for a browser image MIME, which nothing but the
	// catalogued value could have supplied here.
	require.NoError(t, p.GenerateThumb(ctx, n))
	row, err := store.GetThumbnail(ctx, n.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.State)
	require.Equal(t, thumb.OriginalKey, row.StorageKey, "served as-is, not re-encoded")
}
