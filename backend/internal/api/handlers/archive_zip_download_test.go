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
//	/a/dup.txt
//	/b/dup.txt
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
	// Two different files sharing a basename — a selection spanning folders,
	// which is what search results and the starred list hand the user.
	write("a/dup.txt", "from a")
	write("b/dup.txt", "from b")
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

/* Internal buckets in a zip download.

   `zipInto` walks `drv.List` directly, which is one of the very few read paths
   in filex that does not go through a listing projection — and the projections
   are the only place `.filex-trash`, `.versions`, `.thumbs` and the E2E marker
   were ever hidden. So a zip of a storage root shipped every account's deleted
   files and the whole revision history to anyone holding viewer on the drive. */

// newZipInternalsFixture seeds one file worth downloading and one of each
// internal bucket beside it, at the root and nested a level down:
//
//	/notes.md
//	/.filex-trash/1700000000__secret.txt
//	/.versions/42/1
//	/.thumbs/42.jpg
//	/.filex-e2e.json
//	/Design/logo.svg
//	/Design/.versions/7/1
func newZipInternalsFixture(t *testing.T) *handlers.Archive {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	dir := t.TempDir()
	write := func(rel, body string) {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644))
	}
	write("notes.md", "# notes")
	write(".filex-trash/1700000000__secret.txt", "somebody else's deletion")
	write(".versions/42/1", "an older revision")
	write(".thumbs/42.jpg", "JPG")
	write(".filex-e2e.json", `{"marker":true}`)
	write("Design/logo.svg", "<svg/>")
	write("Design/.versions/7/1", "an older logo")

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

func TestDownloadZip_LeavesTheInternalBucketsOutOfTheArchive(t *testing.T) {
	ah := newZipInternalsFixture(t)
	rec := download(t, ah, url.Values{"path": []string{"main://"}})
	require.Equal(t, 200, rec.Code, rec.Body.String())

	got := members(t, rec.Body.Bytes())
	for name := range got {
		for _, bucket := range []string{".filex-trash", ".versions", ".thumbs", ".filex-e2e.json"} {
			require.NotContains(t, name, bucket,
				"an internal bucket reached the archive as %q: a zip download is not a way round the listing projections", name)
		}
	}
	// The refusal has to stay a refusal of the buckets only — everything the
	// caller actually asked for is still there.
	require.Equal(t, "# notes", got["main/notes.md"])
	require.Equal(t, "<svg/>", got["main/Design/logo.svg"])
}

func TestDownloadZip_RefusesAnInternalBucketAsTheDownloadRoot(t *testing.T) {
	ah := newZipInternalsFixture(t)
	// Skipping the buckets during the walk is not enough on its own: naming one
	// as the root would step past the walk's own filter.
	for _, p := range []string{"main://.filex-trash", "main://.versions", "main://.versions/42", "main://.thumbs", "main://Design/.versions"} {
		rec := download(t, ah, url.Values{"path": []string{p}})
		require.Equal(t, 403, rec.Code, "path %q", p)
		require.NotEqual(t, "application/zip", rec.Header().Get("Content-Type"), "path %q", p)
		require.NotContains(t, rec.Body.String(), "secret", "path %q", p)
	}
}

/* Two selected paths with the same basename.

   A download root is named after its basename, so `main://a/dup.txt` and
   `main://b/dup.txt` both wanted to be `dup.txt`. Zip permits duplicate member
   names and every unpacker silently keeps the last one, so one of the two files
   simply never arrived — no error, no warning, a 200 and a short archive. */

func TestDownloadZip_SameBasenameFromTwoFoldersStaysTwoMembers(t *testing.T) {
	ah := newZipFixture(t)
	rec := download(t, ah, url.Values{"path": []string{"main://a/dup.txt", "main://b/dup.txt"}})
	require.Equal(t, 200, rec.Code, rec.Body.String())

	got := members(t, rec.Body.Bytes())
	names := make([]string, 0, len(got))
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	require.Equal(t, []string{"dup (2).txt", "dup.txt"}, names,
		"both selected files have to reach the archive under names of their own")
	require.Equal(t, "from a", got["dup.txt"], "selection order decides which one keeps the plain name")
	require.Equal(t, "from b", got["dup (2).txt"], "and the second keeps its own bytes, not a copy of the first")
}
