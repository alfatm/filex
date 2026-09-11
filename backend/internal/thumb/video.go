package thumb

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
)

// firstLitFrame is the filter chain that finds the first frame with a picture
// on it.
//
// `blackframe` scores every frame it is given — `amount=0` is what makes it
// report on all of them rather than only the ones it already calls black — and
// writes the share of dark pixels into frame metadata. `metadata=select` then
// passes the first frame whose share is under the ceiling, and `-frames:v 1`
// stops there.
//
// ⚠ It CAN select nothing: a video that opens on a long fade-in, a night
// scene, anything shot dark. ffmpeg then encodes no frame and exits non-zero,
// which is why the caller has a second pass rather than trusting this one.
const firstLitFrame = "blackframe=amount=0:threshold=32," +
	"metadata=select:key=lavfi.blackframe.pblack:value=90:function=less"

// litScanSeconds caps how far the search for a lit frame decodes. Without it a
// two-hour film that is dark throughout is decoded end to end to answer "there
// is no lit frame" — the fallback pass reaches the same conclusion in a second.
const litScanSeconds = "60"

// generateVideo writes a video's poster frame: the first one that is not
// blank.
//
// It used to be whatever sat at 00:00:01, which is a coin flip — a fade from
// black, a title card, a leader — and a black tile is indistinguishable from a
// thumbnail that failed to render. Two passes: the first looks for a frame
// with a picture on it, the second takes the old fixed second so that a video
// which is genuinely dark all through still gets a tile.
//
// The source is staged to a tmp file rather than piped: ffmpeg's
// seek-after-pipe behaviour is unreliable on long videos, and both passes read
// the same staged copy.
func (p *Pipeline) generateVideo(ctx context.Context, node *model.Node, drv storage.Driver) error {
	src, done, err := p.stage(ctx, node, drv)
	if err != nil {
		return err
	}
	defer done()
	if err := p.ffmpegStill(ctx, node, src, firstLitFrame, "", litScanSeconds); err == nil {
		return nil
	}
	return p.ffmpegStill(ctx, node, src, "", "1", "")
}

// stage copies a node's bytes to a temp file and hands back its path with the
// cleanup. Through openSource like every generator, so a file still being
// transferred thumbnails from the staged upload.
func (p *Pipeline) stage(ctx context.Context, node *model.Node, drv storage.Driver) (string, func(), error) {
	tmp, err := os.CreateTemp("", "filex-vid-*.bin")
	if err != nil {
		return "", func() {}, err
	}
	done := func() { _ = os.Remove(tmp.Name()) }

	rc, err := p.openSource(ctx, drv, node)
	if err != nil {
		tmp.Close()
		done()
		return "", func() {}, err
	}
	_, err = io.Copy(tmp, rc)
	rc.Close()
	tmp.Close()
	if err != nil {
		done()
		return "", func() {}, err
	}
	return tmp.Name(), done, nil
}

// ffmpegStill grabs one frame from a staged file into the node's cached JPEG.
//
// `filter` is prepended to the scaling (empty for none), `seek` is -ss (empty
// for frame zero) and `limit` is -t, bounding how much is decoded before the
// attempt gives up. An attempt that selects no frame exits non-zero: the
// caller decides whether that is a failure or a reason to try differently.
func (p *Pipeline) ffmpegStill(ctx context.Context, node *model.Node, src, filter, seek, limit string) error {
	if err := os.MkdirAll(p.cacheDir, 0o755); err != nil {
		return err
	}
	scale := fmt.Sprintf("scale=%d:-1", thumbMaxWidth)
	if filter != "" {
		scale = filter + "," + scale
	}
	args := []string{"-y"}
	if seek != "" {
		args = append(args, "-ss", seek)
	}
	args = append(args, "-i", src)
	if limit != "" {
		args = append(args, "-t", limit)
	}
	args = append(args,
		"-frames:v", "1",
		"-vf", scale,
		"-q:v", "5",
		filepath.Join(p.cacheDir, fmt.Sprintf("%d.jpg", node.ID)),
	)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("thumb: ffmpeg: %w (%s)", err, string(out))
	}
	return nil
}
