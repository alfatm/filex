package thumb

import (
	"context"
	"image/gif"
	"io"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
)

// Animated images get a STILL FIRST FRAME as their thumbnail, never the file
// itself. A tile that plays is a listing full of moving pictures, and it is
// also the whole animation downloaded for a 320px square.
//
// Of the four browser images only GIF and WebP can animate, and they need
// different handling:
//
//   - GIF decodes with the standard library, whose gif.Decode already answers
//     with the first frame — the ordinary image generator does the right thing
//     as soon as it is reached;
//   - WebP does not decode at all: x/image/webp reads still files only, so an
//     animated one has to go out to ffmpeg. Without ffmpeg there is nothing to
//     extract a frame with, and the row skips with that reason rather than
//     recording a decode failure that no retry will ever fix.

// animatedWebPReason is the `skipped` reason for an animated WebP on an
// install with no ffmpeg. It names the tool, because the row is the only place
// an operator sees why these tiles are placeholders.
const animatedWebPReason = "animated WebP needs ffmpeg (not in PATH)"

// gifAnimated reports whether a GIF carries more than one frame.
//
// Called only for files under SmallImageBytes — the only ones that would
// otherwise be served as-is — so reading the whole file to count frames is
// bounded by that rule. A source that cannot be read or parsed answers "no":
// the caller then serves the original, which is what it did before this check
// existed.
func (p *Pipeline) gifAnimated(ctx context.Context, drv storage.Driver, node *model.Node) bool {
	rc, err := p.openSource(ctx, drv, node)
	if err != nil {
		return false
	}
	defer rc.Close()
	g, err := gif.DecodeAll(io.LimitReader(rc, SmallImageBytes))
	return err == nil && len(g.Image) > 1
}

// webpAnimated reports whether a WebP is an animation, from its header alone.
//
// Unlike the GIF probe this one is cheap at ANY size — it reads 21 bytes — so
// it runs for every WebP, not just the small ones: a large animated WebP is
// equally undecodable by the image generator and equally needs ffmpeg.
func (p *Pipeline) webpAnimated(ctx context.Context, drv storage.Driver, node *model.Node) bool {
	rc, err := p.openSource(ctx, drv, node)
	if err != nil {
		return false
	}
	defer rc.Close()
	return webpAnimatedHeader(rc)
}

// webpAnimatedHeader decides from the RIFF container: an animated file is an
// EXTENDED WebP — `RIFF<size>WEBPVP8X<size><flags>` — with the ANIM bit set in
// the first flags byte. A plain lossy or lossless one carries VP8 / VP8L in
// that slot and never animates.
func webpAnimatedHeader(r io.Reader) bool {
	var head [21]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return false
	}
	if string(head[0:4]) != "RIFF" || string(head[8:12]) != "WEBP" || string(head[12:16]) != "VP8X" {
		return false
	}
	const animFlag = 0x02
	return head[20]&animFlag != 0
}

// generateAnimatedWebP writes an animated WebP's first LIT frame as the cached
// JPEG — the same rule a video poster follows, and for the same reason: a loop
// that fades in from black would otherwise be represented by the black.
//
// No seek on either pass. These are short loops, and asking for the frame at
// one second lands past the end of most of them.
func (p *Pipeline) generateAnimatedWebP(ctx context.Context, node *model.Node, drv storage.Driver) error {
	src, done, err := p.stage(ctx, node, drv)
	if err != nil {
		return err
	}
	defer done()
	if err := p.ffmpegStill(ctx, node, src, firstLitFrame, "", ""); err == nil {
		return nil
	}
	return p.ffmpegStill(ctx, node, src, "", "", "")
}
