package thumb

import (
	"context"
	"fmt"
	"image"
	_ "image/gif" // register GIF decoder
	"image/jpeg"
	_ "image/png" // register PNG decoder
	"io"
	"os"
	"path/filepath"

	// Register additional image formats used by the SFC's example
	// fixtures + real-world S3 storage. Without these the pipeline
	// flags rows as state="failed" and the GridView falls back to
	// the file-type emoji forever.
	_ "golang.org/x/image/bmp"  // bmp
	_ "golang.org/x/image/tiff" // tiff (scan.tiff fixture)
	_ "golang.org/x/image/webp" // webp (photo.webp fixture)

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
)

const (
	thumbMaxWidth  = 320
	thumbMaxHeight = 320
	thumbQuality   = 80
)

// generateImage creates a thumbnail JPEG using the standard library.
//
// It does NOT pull in disintegration/imaging (saves ~1MB of binary) — for
// sub-square downsampling we use a simple nearest-neighbour-ish step that's
// fine for 320px previews. Use libvips for production-quality scaling.
func (p *Pipeline) generateImage(ctx context.Context, node *model.Node, drv storage.Driver) error {
	rc, err := p.openSource(ctx, drv, node)
	if err != nil {
		return err
	}
	defer rc.Close()
	src, _, err := image.Decode(io.LimitReader(rc, 50*1024*1024))
	if err != nil {
		return fmt.Errorf("thumb: decode: %w", err)
	}
	dst := scaleDown(src, thumbMaxWidth, thumbMaxHeight)

	if err := os.MkdirAll(p.cacheDir, 0o755); err != nil {
		return err
	}
	out, err := os.Create(filepath.Join(p.cacheDir, fmt.Sprintf("%d.jpg", node.ID)))
	if err != nil {
		return err
	}
	defer out.Close()
	if err := jpeg.Encode(out, dst, &jpeg.Options{Quality: thumbQuality}); err != nil {
		return err
	}
	return nil
}

// scaleDown is a stdlib-only nearest-neighbour resize keeping aspect ratio.
// For higher fidelity, swap in golang.org/x/image/draw with BiLinear.
func scaleDown(src image.Image, maxW, maxH int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxW && h <= maxH {
		return src
	}
	ratio := float64(w) / float64(h)
	tw, th := maxW, maxH
	if ratio > float64(maxW)/float64(maxH) {
		th = int(float64(maxW) / ratio)
	} else {
		tw = int(float64(maxH) * ratio)
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	for y := 0; y < th; y++ {
		sy := y * h / th
		for x := 0; x < tw; x++ {
			sx := x * w / tw
			dst.Set(x, y, src.At(b.Min.X+sx, b.Min.Y+sy))
		}
	}
	return dst
}

// maxRawTilePixels caps what a tile is allowed to make the browser decode.
//
// ⚠⚠ Bytes are a POOR proxy for decode cost, and SmallImageBytes alone was the
// whole rule: a file under it is served byte for byte as its own tile. WebP and
// AVIF fold an 8K frame into a few hundred KB, so a 7680x4320 photo sailed
// under a 500 KB limit — and every tile then cost the browser a 33-megapixel
// decode, over 100 MB of bitmap, to paint a 320px square. That was not a
// rounding error: it was a stable half-second stall on the picture, blamed on
// the network and on the server, neither of which was doing anything (the
// endpoint answers in 2 ms).
//
// 4 megapixels is roughly where a re-encode starts paying for itself: below it
// the decode is unnoticeable and the cache file would save nothing, above it
// the 320px JPEG is cheaper than the original by orders of magnitude.
const maxRawTilePixels = 2000 * 2000

// fitsRawTile reports whether a node's own bytes are cheap enough to decode to
// stand as its tile. Only the HEADER is read — DecodeConfig stops once it has
// the dimensions — so this costs a few hundred bytes, not the file, and it runs
// when the node is catalogued, not when a tile is served.
//
// Dimensions it cannot read answer true, which keeps the file's current
// picture. The alternative is to send it to generateImage, whose full Decode
// goes through the SAME format registry that just failed on the header — so a
// format this cannot measure is one that would fail there too, leaving the row
// `failed` and the file with no picture at all. A tile that is slow beats a
// tile that is missing.
func (p *Pipeline) fitsRawTile(ctx context.Context, drv storage.Driver, node *model.Node) bool {
	rc, err := p.openSource(ctx, drv, node)
	if err != nil {
		return true
	}
	defer rc.Close()
	cfg, _, err := image.DecodeConfig(rc)
	if err != nil {
		return true
	}
	return cfg.Width*cfg.Height <= maxRawTilePixels
}
