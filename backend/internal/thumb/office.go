package thumb

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
)

// A conversion service forks a real LibreOffice per document, so the round trip
// is seconds for a letter and can be a minute for a 200-sheet workbook. The
// ceiling exists so a wedged service cannot pin a thumbnail worker forever; the
// caller's ctx still cancels earlier when it is shorter.
const officeConvertTimeout = 2 * time.Minute

// officeConvertPath is Gotenberg's LibreOffice route, and `files` its upload
// field. The service is addressed by base URL so any Gotenberg-compatible
// deployment works; nothing else about the protocol is used, which is why there
// is no client library here.
const (
	officeConvertPath  = "/forms/libreoffice/convert"
	officeConvertField = "files"
)

// generateOffice converts a doc/xls/ppt/odt/ods/odp to PDF, then re-uses the
// PDF generator to render page 1.
//
// The conversion runs in whichever of the two converters is available, and the
// remote one wins: LibreOffice is by far the heaviest thing filex ever shells
// out to (~730 MB of packages, a fork per document), so the supported shape is
// a separate service, with the local binary kept for installs that already have
// soffice on the host.
func (p *Pipeline) generateOffice(ctx context.Context, node *model.Node, drv storage.Driver) error {
	remote := p.officeConvertURL(ctx)
	bin := officeBin()
	if remote == "" && bin == "" {
		return fmt.Errorf("thumb: %s", officeUnavailableReason)
	}

	tmpDir, err := os.MkdirTemp("", "filex-office-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	srcName := filepath.Base(node.Name)
	if srcName == "" {
		srcName = "input"
	}
	srcPath := filepath.Join(tmpDir, srcName)
	src, err := os.Create(srcPath)
	if err != nil {
		return err
	}
	rc, err := p.openSource(ctx, drv, node)
	if err != nil {
		src.Close()
		return err
	}
	if _, err := io.Copy(src, rc); err != nil {
		rc.Close()
		src.Close()
		return err
	}
	rc.Close()
	src.Close()

	pdfPath := ""
	if remote != "" {
		pdfPath = filepath.Join(tmpDir, "converted.pdf")
		if err := convertOfficeRemote(ctx, remote, srcPath, pdfPath); err != nil {
			return err
		}
	} else {
		pdfPath, err = convertOfficeLocal(ctx, bin, tmpDir, srcName, srcPath)
		if err != nil {
			return err
		}
	}

	// Now reuse the gs/pdftoppm path.
	if err := os.MkdirAll(p.cacheDir, 0o755); err != nil {
		return err
	}
	out := filepath.Join(p.cacheDir, fmt.Sprintf("%d.jpg", node.ID))
	if path, _ := exec.LookPath("gs"); path != "" {
		cmd := exec.CommandContext(ctx, path,
			"-sDEVICE=jpeg",
			"-dFirstPage=1", "-dLastPage=1",
			"-r96",
			"-dJPEGQ=80",
			"-o", out,
			pdfPath,
		)
		if outBytes, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("thumb: gs after office conversion: %w (%s)", err, string(outBytes))
		}
		return nil
	}
	if path, _ := exec.LookPath("pdftoppm"); path != "" {
		cmd := exec.CommandContext(ctx, path,
			"-jpeg", "-f", "1", "-l", "1", "-r", "96",
			pdfPath, out[:len(out)-4],
		)
		if outBytes, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("thumb: pdftoppm after office conversion: %w (%s)", err, string(outBytes))
		}
		_ = os.Rename(out[:len(out)-4]+"-1.jpg", out)
		return nil
	}
	return fmt.Errorf("thumb: office converted OK but no PDF→JPG renderer")
}

// OfficeBinAvailable reports whether a local LibreOffice is installed.
//
// Exported for the bootstrap, which must fill Capabilities.Office with the
// LOCAL answer only: `/api/capabilities` reports `thumbs.office` true for a
// configured remote service too, and feeding that back in would leave the
// pipeline believing it has a local binary it does not have.
func OfficeBinAvailable() bool { return officeBin() != "" }

// officeBin resolves the local LibreOffice binary, empty when neither name is
// in $PATH.
func officeBin() string {
	for _, candidate := range []string{"libreoffice", "soffice"} {
		if path, _ := exec.LookPath(candidate); path != "" {
			return path
		}
	}
	return ""
}

// convertOfficeLocal shells out to headless LibreOffice and returns the path of
// the PDF it produced, which is inside tmpDir.
func convertOfficeLocal(ctx context.Context, bin, tmpDir, srcName, srcPath string) (string, error) {
	cmd := exec.CommandContext(ctx, bin,
		"--headless",
		"--norestore",
		"--nologo",
		"--nofirststartwizard",
		"-env:UserInstallation=file://"+tmpDir+"/lo-profile",
		"--convert-to", "pdf",
		"--outdir", tmpDir,
		srcPath,
	)
	// Confine LibreOffice's per-user state to the per-call tmp dir so
	// concurrent backfill workers don't collide on the shared
	// /root/.config/libreoffice/4/user lock and so the "Warning:
	// failed to read path from javaldx" stderr line stops hitting
	// process logs on first invocation.
	cmd.Env = append(append([]string(nil), os.Environ()...),
		"HOME="+tmpDir,
		"XDG_CACHE_HOME="+tmpDir+"/cache",
		"XDG_CONFIG_HOME="+tmpDir+"/config",
		"XDG_DATA_HOME="+tmpDir+"/data",
	)
	combined, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("thumb: libreoffice: %w (%s)", err, strings.TrimSpace(string(combined)))
	}

	pdfName := strings.TrimSuffix(srcName, filepath.Ext(srcName)) + ".pdf"
	pdfPath := filepath.Join(tmpDir, pdfName)
	if _, statErr := os.Stat(pdfPath); statErr == nil {
		return pdfPath, nil
	}

	// soffice exited 0 but there is no PDF — this usually happens when the
	// source file does not match the schema soffice expects (truncated pptx,
	// etc.) or when the output name does not match our convention. Attach
	// soffice's own stdout/stderr so the root cause is visible.
	entries, _ := os.ReadDir(tmpDir)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slog.Warn("thumb: libreoffice produced no PDF",
		slog.String("src", srcName),
		slog.String("expected", pdfPath),
		slog.String("tmp_dir_listing", strings.Join(names, ",")),
		slog.String("soffice_output", strings.TrimSpace(string(combined))),
	)
	// Fallback: scan tmpDir for ANY .pdf — soffice occasionally names the file
	// after the embedded document title rather than the source filename.
	for _, e := range entries {
		if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".pdf") {
			return filepath.Join(tmpDir, e.Name()), nil
		}
	}
	return "", fmt.Errorf("thumb: libreoffice produced no PDF: %s (cmd output: %s)", pdfPath, strings.TrimSpace(string(combined)))
}

// convertOfficeRemote uploads srcPath to a Gotenberg-compatible conversion
// service and writes the PDF it answers with to outPath.
//
// The multipart body is assembled in a FILE next to the source, not in memory.
// The service needs a Content-Length to accept the upload, and buffering to get
// one would mean holding a whole spreadsheet in RAM — per concurrent backfill
// worker — for a file whose only purpose here is a 320px tile.
func convertOfficeRemote(ctx context.Context, baseURL, srcPath, outPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()

	body, err := os.CreateTemp(filepath.Dir(outPath), "upload-*.multipart")
	if err != nil {
		return err
	}
	defer os.Remove(body.Name())
	defer body.Close()

	mw := multipart.NewWriter(body)
	// The filename carries the extension, and the extension is what the
	// service picks its import filter by — a name it cannot classify comes
	// back as an error, not as a wrong-looking PDF.
	part, err := mw.CreateFormFile(officeConvertField, filepath.Base(srcPath))
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, src); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}
	size, err := body.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, officeConvertTimeout)
	defer cancel()

	url := strings.TrimRight(baseURL, "/") + officeConvertPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.ContentLength = size

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("thumb: office service %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		// The service answers failures as text (an unsupported format, a
		// password-protected file); keep a bounded slice of it, because it is
		// the only description of what went wrong the operator will ever get.
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("thumb: office service %s: HTTP %d (%s)", url, resp.StatusCode, strings.TrimSpace(string(detail)))
	}

	out, err := os.Create(outPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
