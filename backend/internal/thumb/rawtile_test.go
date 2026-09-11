package thumb_test

// A file under SmallImageBytes is served as its OWN bytes — no re-encode, no
// cache file. These tests pin the second half of that rule: the file also has
// to be cheap to DECODE. Bytes alone let a 7680x4320 WebP through at under
// 400 KB, and the browser then spent half a second on a 33-megapixel decode to
// paint a 320px square.

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil/dbtest"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// rawTileFixture is dispatchFixture with the driver's ROOT handed back: unlike
// the dispatch tests, these need real bytes on disk — the whole question is
// what the decoder reads out of the file's header.
func rawTileFixture(t *testing.T) (db.Store, *thumb.Pipeline, int64, string) {
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

	p := thumb.New(store, t.TempDir(), thumb.Capabilities{Image: true})
	p.AttachStorage(st.ID, drv)
	return store, p, st.ID, root
}

// writePNG lays down a flat-colour PNG of the given dimensions and catalogues
// it. Flat colour on purpose: it compresses to almost nothing, which is exactly
// the shape that defeats a byte limit — enormous to decode, tiny on disk.
func writePNG(t *testing.T, store db.Store, sid int64, root, name string, w, h int) *model.Node {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		img.Set(x, 0, color.RGBA{R: uint8(x), G: 0x80, B: 0x40, A: 0xff})
	}
	f, err := os.Create(filepath.Join(root, name))
	require.NoError(t, err)
	require.NoError(t, png.Encode(f, img))
	require.NoError(t, f.Close())

	st, err := os.Stat(filepath.Join(root, name))
	require.NoError(t, err)
	require.Less(t, st.Size(), int64(thumb.SmallImageBytes), "the fixture must be under the byte limit, or it proves nothing")

	n, err := store.CreateNode(context.Background(), &model.Node{
		StorageID: sid, Name: name, Path: "/" + name,
		PathHash: pathkey.Hash(sid, "/"+name), Type: model.NodeTypeFile, Size: st.Size(),
	})
	require.NoError(t, err)
	return n
}

// ⚠ The headline: small on disk is not small to decode.
func TestGenerateThumb_HugePixelsAreRenderedEvenWhenTheFileIsTiny(t *testing.T) {
	ctx := context.Background()
	store, p, sid, root := rawTileFixture(t)
	n := writePNG(t, store, sid, root, "wall.png", 4000, 3000) // 12 MP, a few KB

	require.NoError(t, p.GenerateThumb(ctx, n))
	row, err := store.GetThumbnail(ctx, n.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.State)
	require.NotEqual(t, thumb.OriginalKey, row.StorageKey, "12 megapixels must not be handed to the browser raw")
	require.FileExists(t, p.CachePath(n.ID), "a rendered tile means a cache file")
}

// The rule it must not break: an ordinary small photo still costs no render
// and no cache file.
func TestGenerateThumb_ModestPixelsStayTheirOwnTile(t *testing.T) {
	ctx := context.Background()
	store, p, sid, root := rawTileFixture(t)
	n := writePNG(t, store, sid, root, "photo.png", 800, 600)

	require.NoError(t, p.GenerateThumb(ctx, n))
	row, err := store.GetThumbnail(ctx, n.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.State)
	require.Equal(t, thumb.OriginalKey, row.StorageKey, "served as-is, nothing gained by re-encoding it")
	require.NoFileExists(t, p.CachePath(n.ID))
}
