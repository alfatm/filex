package handlers_test

// The filter chips on the folder listing itself. `q=index` is not paged, so
// unlike the flat listings this was never about reach — it is about one folder
// and one flat listing meaning the same thing by `ext`, and about `total`: the
// folder's UNFILTERED count, which is how the client tells a narrowed answer
// from an empty folder.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type indexFacetFixture struct {
	mh    *handlers.Manager
	store db.Store
	st    *model.Storage
	root  string
}

func newIndexFacetFixture(t *testing.T) *indexFacetFixture {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	root := t.TempDir()
	drv := &local.Driver{}
	require.NoError(t, drv.Init(context.Background(), map[string]any{"root": root}))
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(root) + `"}`),
	})
	require.NoError(t, err)
	resolver := func(id int64) (storage.Driver, error) {
		if id == st.ID {
			return drv, nil
		}
		return nil, fmt.Errorf("unknown id %d", id)
	}
	return &indexFacetFixture{mh: handlers.NewManager(store, resolver), store: store, st: st, root: root}
}

func (f *indexFacetFixture) node(t *testing.T, name string, kind model.NodeType, size int64, mtime time.Time) *model.Node {
	t.Helper()
	n, err := f.store.CreateNode(context.Background(), &model.Node{
		StorageID: f.st.ID, Name: name, Path: "/" + name, PathHash: pathkey.Hash(f.st.ID, "/"+name),
		Type: kind, Size: size, BackendMtime: &mtime,
	})
	require.NoError(t, err)
	return n
}

// index lists the storage root with the given extra query and returns the
// row names (sorted — the order is the listing's business, not this test's)
// and `total`.
func (f *indexFacetFixture) index(t *testing.T, query url.Values) ([]string, int) {
	t.Helper()
	query.Set("q", "index")
	query.Set("path", "main://")
	rec := callList(t, f.mh, query)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Files []struct {
			Basename string `json:"basename"`
		} `json:"files"`
		Total int `json:"total"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	names := make([]string, 0, len(out.Files))
	for _, row := range out.Files {
		names = append(names, row.Basename)
	}
	sort.Strings(names)
	return names, out.Total
}

func TestManagerIndex_FacetsNarrowFilesAndTotalStaysWhole(t *testing.T) {
	fx := newIndexFacetFixture(t)
	old := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	recent := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	cut := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	fx.node(t, "Reports", model.NodeTypeDirectory, 0, recent)
	fx.node(t, "report.md", model.NodeTypeFile, 10, recent)
	fx.node(t, "notes.txt", model.NodeTypeFile, 5000, old)
	fx.node(t, "Repo.PDF", model.NodeTypeFile, 100, recent)

	all, total := fx.index(t, url.Values{})
	assert.Equal(t, []string{"Repo.PDF", "Reports", "notes.txt", "report.md"}, all)
	assert.Equal(t, 4, total)

	md, total := fx.index(t, url.Values{"ext": {"md"}})
	assert.Equal(t, []string{"report.md"}, md, "an extension filter is a filter for files: the folder is out")
	assert.Equal(t, 4, total, "total is the folder's unfiltered count")

	rep, total := fx.index(t, url.Values{"name": {"REP"}})
	assert.Equal(t, []string{"Repo.PDF", "Reports", "report.md"}, rep, "a case-insensitive substring, and folders have names too")
	assert.Equal(t, 4, total)

	big, _ := fx.index(t, url.Values{"size_min": {"1000"}})
	assert.Equal(t, []string{"notes.txt"}, big, "a size band drops folders")

	since, _ := fx.index(t, url.Values{"modified_after": {fmt.Sprint(cut.UnixMilli())}})
	assert.Equal(t, []string{"Repo.PDF", "Reports", "report.md"}, since, "a date window keeps folders")

	none, total := fx.index(t, url.Values{"ext": {"png"}})
	assert.Empty(t, none)
	assert.Equal(t, 4, total, "an empty filtered answer over a full folder is not an empty folder")
}

// The cold-cache fallback reads the folder off its driver; the same chips have
// to mean the same thing there.
func TestManagerIndex_FacetsApplyOnTheDriverFallback(t *testing.T) {
	fx := newIndexFacetFixture(t)
	require.NoError(t, os.WriteFile(filepath.Join(fx.root, "report.md"), []byte("# r"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(fx.root, "notes.txt"), []byte("n"), 0o644))
	require.NoError(t, os.Mkdir(filepath.Join(fx.root, "Reports"), 0o755))

	all, total := fx.index(t, url.Values{})
	assert.Equal(t, []string{"Reports", "notes.txt", "report.md"}, all)
	assert.Equal(t, 3, total)

	md, total := fx.index(t, url.Values{"ext": {"md"}})
	assert.Equal(t, []string{"report.md"}, md)
	assert.Equal(t, 3, total, "total counts what the driver returned, before the filter")

	rep, _ := fx.index(t, url.Values{"name": {"rep"}})
	assert.Equal(t, []string{"Reports", "report.md"}, rep)
}

// `action=subfolders` is the destination picker's tree walk: no chip narrows it.
func TestManagerIndex_SubfoldersIgnoreFacets(t *testing.T) {
	fx := newIndexFacetFixture(t)
	fx.node(t, "Reports", model.NodeTypeDirectory, 0, time.Now())
	rec := callList(t, fx.mh, url.Values{"action": {"subfolders"}, "path": {"main://"}, "ext": {"md"}})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Folders []map[string]any `json:"folders"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Len(t, out.Folders, 1)
}
