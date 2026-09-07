package handlers_test

/* GET /api/files/download/zip — a folder, or a mixed selection, as one archive.

   Until this existed the app downloaded a selection one file at a time and had
   nothing at all to offer for a folder: the selection bar's Download button was
   inert whenever a folder was in it. */

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/filebody"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// newZipFixture seeds a drive with a small tree:
//
//	/notes.md
//	/Design/logo.svg
//	/Design/raw/shot.png
//	/Empty/
func newZipFixture(t *testing.T) *handlers.Archive {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	dir := t.TempDir()
	write := func(rel, body string) {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644))
	}
	write("notes.md", "# notes")
	write("Design/logo.svg", "<svg/>")
	write("Design/raw/shot.png", "PNG")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "Empty"), 0o755))

	drv := &local.Driver{}
	require.NoError(t, drv.Init(context.Background(), map[string]any{"root": dir}))
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name: "main", Driver: "local", MountPath: "/data", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(dir) + `"}`),
	})
	require.NoError(t, err)

	ah := handlers.NewArchive(store, func(id int64) (storage.Driver, error) {
		if id != st.ID {
			return nil, fmt.Errorf("unknown id %d", id)
		}
		return drv, nil
	})
	ah.AttachBody(filebody.New(store, nil))
	return ah
}

// members maps entry name → contents; a directory entry keeps its trailing slash.
func members(t *testing.T, body []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	require.NoError(t, err, "the response has to be a readable zip")
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		require.NoError(t, err)
		buf := new(bytes.Buffer)
		_, err = buf.ReadFrom(rc)
		require.NoError(t, err)
		rc.Close()
		out[f.Name] = buf.String()
	}
	return out
}

func download(t *testing.T, ah *handlers.Archive, q url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/files/download/zip?"+q.Encode(), nil)
	rec := httptest.NewRecorder()
	ah.DownloadZip(rec, req)
	return rec
}

func TestDownloadZip_FolderKeepsItsShape(t *testing.T) {
	ah := newZipFixture(t)
	rec := download(t, ah, url.Values{"path": []string{"main://Design"}})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Equal(t, "application/zip", rec.Header().Get("Content-Type"))
	require.Contains(t, rec.Header().Get("Content-Disposition"), `filename="Design.zip"`)

	got := members(t, rec.Body.Bytes())
	names := make([]string, 0, len(got))
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	require.Equal(t, []string{"Design/logo.svg", "Design/raw/shot.png"}, names,
		"the selected folder is the archive's root, and the subtree keeps its nesting")
	require.Equal(t, "<svg/>", got["Design/logo.svg"])
	require.Equal(t, "PNG", got["Design/raw/shot.png"])
}

func TestDownloadZip_MixedSelectionAndEmptyFolders(t *testing.T) {
	ah := newZipFixture(t)
	rec := download(t, ah, url.Values{"path": []string{"main://notes.md", "main://Empty"}})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	// Nothing to name the archive after when several things were picked.
	require.Contains(t, rec.Header().Get("Content-Disposition"), `filename="files.zip"`)

	got := members(t, rec.Body.Bytes())
	require.Equal(t, "# notes", got["notes.md"])
	_, hasEmpty := got["Empty/"]
	require.True(t, hasEmpty, "an empty folder was part of the selection and must not vanish from the archive")
}

func TestDownloadZip_RefusesBeforeItStartsWriting(t *testing.T) {
	ah := newZipFixture(t)
	// A missing path is a 404 and not a zip: once a header is on the wire the
	// status is 200 for good, so everything answerable must be answered first.
	rec := download(t, ah, url.Values{"path": []string{"main://nope"}})
	require.Equal(t, 404, rec.Code)
	require.NotEqual(t, "application/zip", rec.Header().Get("Content-Type"))

	rec = download(t, ah, url.Values{})
	require.Equal(t, 400, rec.Code)
}
