package thumb_test

// The thumbnail pipeline over a PLUGIN-backed storage.
//
// Why this file exists: the pipeline is the one consumer that reads a whole
// object and then decides, from the bytes alone, whether the file is usable.
// It is attached to a driver per storage (AttachStorage) and reads through it
// directly, so a plugin whose read stream is truncated, buffered wrong or
// closed early produces a "failed" thumbnail — and a failed thumbnail is not
// an error anybody sees, it is a grid of grey placeholders that looks like a
// design choice.
//
// Only the IMAGE path is exercised. It is pure Go (image/png in, image/jpeg
// out) and therefore hermetic; video, audio, PDF and office all shell out to
// ffmpeg / ghostscript / libreoffice, so they are left to a machine that has
// them — see the skip at the bottom for exactly what is not measured here.

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/plugin/testplugin"
	"github.com/brf-tech/filex/backend/internal/testutil/dbtest"
	"github.com/brf-tech/filex/backend/internal/thumb"
)

// pngBytes builds a real PNG rather than pasting a base64 blob, so the fixture
// says what it is and a decode failure cannot be blamed on the fixture.
func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 0x40, A: 0xff})
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

// animatedGifBytes is a two-frame GIF: the smallest thing that must NOT be
// served as its own tile.
func animatedGifBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	frames := make([]*image.Paletted, 2)
	delays := make([]int, 2)
	for i := range frames {
		f := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
		f.SetColorIndex(i, 0, uint8(i))
		frames[i] = f
		delays[i] = 10
	}
	var buf bytes.Buffer
	require.NoError(t, gif.EncodeAll(&buf, &gif.GIF{Image: frames, Delay: delays}))
	return buf.Bytes()
}

// stillGifBytes is a one-frame GIF — the same format, nothing to play.
func stillGifBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	img.SetColorIndex(1, 1, 1)
	var buf bytes.Buffer
	require.NoError(t, gif.Encode(&buf, img, nil))
	return buf.Bytes()
}

// webpBytes is a WebP header and nothing else. The pipeline decides whether a
// WebP animates from the container alone, so the frames it would hold are not
// part of what is being measured: an extended file carrying the ANIM flag, or
// a plain lossy one that cannot animate at all.
func webpBytes(t *testing.T, animated bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	require.NoError(t, binary.Write(&buf, binary.LittleEndian, uint32(24)))
	buf.WriteString("WEBP")
	if !animated {
		buf.WriteString("VP8 ")
		buf.Write(make([]byte, 12))
		return buf.Bytes()
	}
	buf.WriteString("VP8X")
	require.NoError(t, binary.Write(&buf, binary.LittleEndian, uint32(10)))
	const animFlag = 0x02
	buf.WriteByte(animFlag)
	buf.Write(make([]byte, 9))
	return buf.Bytes()
}

// pluginPipeline wires a pipeline to a storage row backed by a live plugin and
// returns everything the assertions need.
func pluginPipeline(t *testing.T) (db.Store, *thumb.Pipeline, *model.Storage, *testplugin.Plugin) {
	t.Helper()
	ctx := context.Background()
	_, store := dbtest.NewTestDB(t)
	p := testplugin.Start(t)

	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "eklenti", Driver: p.Register(t), MountPath: "/eklenti", Enabled: true,
		ConfigJSON: []byte(`{"root":"/data"}`),
	})
	require.NoError(t, err)

	pipe := thumb.New(store, t.TempDir(), thumb.Capabilities{Image: true})
	pipe.AttachStorage(st.ID, p.Driver(t))
	return store, pipe, st, p
}

func fileNode(t *testing.T, store db.Store, st *model.Storage, path, name string, size int64) *model.Node {
	t.Helper()
	n, err := store.CreateNode(context.Background(), &model.Node{
		StorageID: st.ID, Name: name, Path: path,
		PathHash: pathkey.Hash(st.ID, path), Type: model.NodeTypeFile, Size: size,
	})
	require.NoError(t, err)
	return n
}

// The whole point: bytes that exist only on the plugin come back through the
// driver, decode, and land as a JPEG on disk with a "ready" row behind it.
func TestThumbnailFromAPluginStorage(t *testing.T) {
	store, pipe, st, p := pluginPipeline(t)
	src := pngBytes(t, 640, 480)
	p.SeedBytes("fotograf.png", src)
	// Size is catalogue metadata; claimed above SmallImageBytes so the image
	// path runs (a smaller one is served as-is, see the test below).
	n := fileNode(t, store, st, "/fotograf.png", "fotograf.png", thumb.SmallImageBytes)

	require.NoError(t, pipe.GenerateThumb(context.Background(), n))

	row, err := store.GetThumbnail(context.Background(), n.ID)
	require.NoError(t, err)
	require.NotNil(t, row)
	require.Equal(t, "ready", row.State, "thumbnail error: %s", row.Error)

	out, err := os.ReadFile(pipe.CachePath(n.ID))
	require.NoError(t, err)
	require.True(t, bytes.HasPrefix(out, []byte{0xFF, 0xD8}), "cached thumbnail is not a JPEG")

	// Decoded, not just written: a truncated read produces a file that starts
	// with the right two bytes and is not an image.
	img, format, err := image.Decode(bytes.NewReader(out))
	require.NoError(t, err)
	require.Equal(t, "jpeg", format)
	require.LessOrEqual(t, img.Bounds().Dx(), 320, "thumbnail was not scaled down")
}

// A file the plugin does not have must be recorded as failed, with the reason
// kept. The alternative — a pipeline that swallows the error — leaves a row
// stuck in "pending" forever, which no retry ever picks up and no UI ever
// explains.
func TestThumbnailFailureFromAPluginIsRecorded(t *testing.T) {
	store, pipe, st, _ := pluginPipeline(t)
	n := fileNode(t, store, st, "/yok.png", "yok.png", thumb.SmallImageBytes)

	require.Error(t, pipe.GenerateThumb(context.Background(), n))

	row, err := store.GetThumbnail(context.Background(), n.ID)
	require.NoError(t, err)
	require.NotNil(t, row)
	require.Equal(t, "failed", row.State)
	require.NotEmpty(t, row.Error, "a failed thumbnail with no reason cannot be diagnosed")
}

// Under SmallImageBytes a browser-renderable image is its own tile: the row is
// ready and points at the ORIGINAL, so every client gets a thumb_url for it,
// and nothing is re-encoded — no cache file appears and a backfill leaves the
// row alone.
func TestSmallImageIsServedAsItsOriginal(t *testing.T) {
	store, pipe, st, p := pluginPipeline(t)
	src := pngBytes(t, 64, 64)
	p.SeedBytes("kucuk.png", src)
	n := fileNode(t, store, st, "/kucuk.png", "kucuk.png", int64(len(src)))
	require.Less(t, n.Size, int64(thumb.SmallImageBytes), "fixture must sit under the threshold")

	require.NoError(t, pipe.GenerateThumb(context.Background(), n))

	row, err := store.GetThumbnail(context.Background(), n.ID)
	require.NoError(t, err)
	require.NotNil(t, row)
	require.Equal(t, "ready", row.State)
	require.Equal(t, thumb.OriginalKey, row.StorageKey, "the tile IS the file")
	_, err = os.Stat(pipe.CachePath(n.ID))
	require.True(t, os.IsNotExist(err), "the original must not be re-encoded into the cache")

	// The same bytes claimed to be larger go through the image path as before.
	p.SeedBytes("buyuk.png", src)
	big := fileNode(t, store, st, "/buyuk.png", "buyuk.png", thumb.SmallImageBytes)
	require.NoError(t, pipe.GenerateThumb(context.Background(), big))
	row, err = store.GetThumbnail(context.Background(), big.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.State, "thumbnail error: %s", row.Error)
}

// An ANIMATED image under the size threshold is the exception to serving the
// original: a tile that plays turns a listing into a wall of moving pictures,
// so it is rendered to a still frame like any larger image.
func TestSmallAnimatedGifIsStilledNotServedAsItsOriginal(t *testing.T) {
	store, pipe, st, p := pluginPipeline(t)
	src := animatedGifBytes(t, 32, 32)
	p.SeedBytes("oynayan.gif", src)
	n := fileNode(t, store, st, "/oynayan.gif", "oynayan.gif", int64(len(src)))
	require.Less(t, n.Size, int64(thumb.SmallImageBytes), "fixture must sit under the threshold")

	require.NoError(t, pipe.GenerateThumb(context.Background(), n))

	row, err := store.GetThumbnail(context.Background(), n.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row.State)
	require.NotEqual(t, thumb.OriginalKey, row.StorageKey, "an animated tile must not be the file itself")
	require.FileExists(t, pipe.CachePath(n.ID), "the still frame is a rendered JPEG")

	// A single-frame GIF is not animated and keeps its original: the exception
	// must be about frames, not about the format.
	still := stillGifBytes(t, 32, 32)
	p.SeedBytes("duran.gif", still)
	n2 := fileNode(t, store, st, "/duran.gif", "duran.gif", int64(len(still)))
	require.NoError(t, pipe.GenerateThumb(context.Background(), n2))
	row2, err := store.GetThumbnail(context.Background(), n2.ID)
	require.NoError(t, err)
	require.Equal(t, thumb.OriginalKey, row2.StorageKey)
}

// An animated WebP cannot be decoded by the image generator at all, so on an
// install without ffmpeg it skips WITH THE REASON — it does not record a decode
// failure, and it must never be served as-is, whatever its size.
func TestSmallAnimatedWebPSkipsWithItsReason(t *testing.T) {
	store, pipe, st, p := pluginPipeline(t)
	src := webpBytes(t, true)
	p.SeedBytes("oynayan.webp", src)
	n := fileNode(t, store, st, "/oynayan.webp", "oynayan.webp", int64(len(src)))

	require.ErrorIs(t, pipe.GenerateThumb(context.Background(), n), thumb.ErrSkipped)

	row, err := store.GetThumbnail(context.Background(), n.ID)
	require.NoError(t, err)
	require.Equal(t, "skipped", row.State)
	require.Contains(t, row.Error, "ffmpeg", "the row is where an operator reads what is missing")
	require.NotEqual(t, thumb.OriginalKey, row.StorageKey, "an animation must not be its own tile")

	// A still WebP of the same size is not animated and keeps its original.
	still := webpBytes(t, false)
	p.SeedBytes("duran.webp", still)
	n2 := fileNode(t, store, st, "/duran.webp", "duran.webp", int64(len(still)))
	require.NoError(t, pipe.GenerateThumb(context.Background(), n2))
	row2, err := store.GetThumbnail(context.Background(), n2.ID)
	require.NoError(t, err)
	require.Equal(t, "ready", row2.State)
	require.Equal(t, thumb.OriginalKey, row2.StorageKey)
}

// ⚠ NOT MEASURED, and deliberately so: the video, audio, PDF and office
// branches of the pipeline shell out to ffmpeg, ghostscript/poppler and
// libreoffice. Those binaries are not in this repo's CI image, and a test that
// quietly passed because the capability flag was off would be worse than no
// test — it would claim coverage of the path where a plugin's read stream is
// piped into another process, which is exactly the path most likely to break.
func TestThumbnailNonImagePathsOverAPluginAreUnmeasured(t *testing.T) {
	t.Skip("video/audio/PDF/office thumbnails need ffmpeg, ghostscript and libreoffice; not in CI. " +
		"The image path above covers the plugin read stream; the external-binary branches are unproven over a plugin.")
}
