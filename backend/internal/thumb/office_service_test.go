package thumb

// The office→PDF conversion SERVICE — the converter that replaced a local
// LibreOffice in the shipped image. Two things have to hold for that swap to be
// safe: the request has to be one a Gotenberg-compatible service accepts (route,
// field name, and a filename it can pick an import filter from), and a refusal
// has to arrive as an error carrying the service's own explanation, since that
// text is all an operator gets on the failed row.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConvertOfficeRemote_PostsTheDocumentAndStoresThePDF(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "quarterly report.xlsx")
	require.NoError(t, os.WriteFile(src, []byte("xlsx-bytes"), 0o600))

	var gotPath, gotField, gotFilename string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		f, hdr, err := r.FormFile(officeConvertField)
		if err != nil {
			// Reported through the assertions below rather than here: a 500
			// would be indistinguishable from the refusal path's own test.
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer f.Close()
		gotField = officeConvertField
		gotFilename = hdr.Filename
		gotBody, _ = io.ReadAll(f)
		_, _ = w.Write([]byte("%PDF-1.7 fake"))
	}))
	defer srv.Close()

	// A trailing slash on the configured URL is what an operator pastes out of
	// a browser, and it must not produce a double slash in the route.
	out := filepath.Join(dir, "converted.pdf")
	require.NoError(t, convertOfficeRemote(context.Background(), srv.URL+"/", src, out))

	require.Equal(t, officeConvertPath, gotPath)
	require.Equal(t, "files", gotField)
	require.Equal(t, "quarterly report.xlsx", gotFilename,
		"the extension is what the service picks its import filter by")
	require.Equal(t, []byte("xlsx-bytes"), gotBody)

	pdf, err := os.ReadFile(out)
	require.NoError(t, err)
	require.Equal(t, "%PDF-1.7 fake", string(pdf))
}

func TestConvertOfficeRemote_RefusalCarriesTheServiceExplanation(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "locked.docx")
	require.NoError(t, os.WriteFile(src, []byte("x"), 0o600))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "document is password protected", http.StatusBadRequest)
	}))
	defer srv.Close()

	out := filepath.Join(dir, "converted.pdf")
	err := convertOfficeRemote(context.Background(), srv.URL, src, out)
	require.Error(t, err)
	require.Contains(t, err.Error(), "HTTP 400")
	require.Contains(t, err.Error(), "document is password protected")
	require.NoFileExists(t, out, "a refusal must not leave a truncated PDF behind")
}

// officeReady is the dispatch gate: with a converter configured, an office
// document is rendered even though no libreoffice is installed anywhere — which
// is the whole point of moving the converter out of the image.
func TestOfficeReady_RemoteConverterCountsAsAConverter(t *testing.T) {
	ctx := context.Background()

	none := &Pipeline{}
	require.False(t, none.officeReady(ctx))

	local := &Pipeline{caps: Capabilities{Office: true}}
	require.True(t, local.officeReady(ctx))

	remote := &Pipeline{}
	remote.AttachOfficeConverter(func(context.Context) string { return "http://libreoffice:3000" })
	require.True(t, remote.officeReady(ctx))
	require.Equal(t, "http://libreoffice:3000", remote.officeConvertURL(ctx))

	// An unconfigured external_services row answers with an empty string, and a
	// blank one is the same thing — an operator who cleared the field.
	blank := &Pipeline{}
	blank.AttachOfficeConverter(func(context.Context) string { return "   " })
	require.False(t, blank.officeReady(ctx))
	require.True(t, strings.HasPrefix(officeUnavailableReason, "no office converter"))
}
