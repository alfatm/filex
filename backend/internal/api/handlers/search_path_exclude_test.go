package handlers_test

// `-path:` — the negative half of a path filter.
//
// Each test is the same shape as the scope tests next door: the unfiltered
// query first, so what the exclusion drops is visible, and then the exclusion.
// The three branches that can answer a search are each exercised, because the
// failure this feature can have is not "it does not work" — it is "it works on
// whichever branch you happened to hit".

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func TestSearchExcludePath_DropsTheFolderAndKeepsTheRest(t *testing.T) {
	ctx := context.Background()
	idx, err := search.Open(filepath.Join(t.TempDir(), "idx.bleve"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = idx.Close() })

	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	mk := func(name, p string) *model.Node {
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			Type: model.NodeTypeFile, Mime: "text/plain", Size: 42, Etag: "e-" + p,
		})
		require.NoError(t, cerr)
		require.NoError(t, idx.IndexNode(ctx, n))
		return n
	}
	mk("report.md", "/design/report.md")
	mk("report.md", "/archive/report.md")
	mk("report.md", "/documents/report.md")

	h := handlers.NewSearch(idx, store)
	all := scopeSearch(t, h, map[string]any{"query": "report", "storage_id": st.ID})
	require.Len(t, all, 3, "unfiltered: every copy answers")

	kept := scopeSearchPaths(t, h, map[string]any{"query": "report -path:archive", "storage_id": st.ID})
	assert.ElementsMatch(t, []string{"/design/report.md", "/documents/report.md"}, kept)

	// A whole folder name, not a substring of one: `doc` does not take
	// `/documents` with it, the same rule search.PathExcluded holds.
	kept = scopeSearchPaths(t, h, map[string]any{"query": "report -path:doc", "storage_id": st.ID})
	assert.Len(t, kept, 3, "a partial folder name excludes nothing")
}

// The SQL LIKE fallback is the branch an install with no index runs on, and a
// filter that quietly stops applying there is the worst shape this can take.
func TestSearchExcludePath_AppliesWithoutAnIndex(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	for _, p := range []string{"/design/report.md", "/archive/report.md"} {
		_, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: "report.md", Path: p, PathHash: pathkey.Hash(st.ID, p),
			Type: model.NodeTypeFile, Size: 42,
		})
		require.NoError(t, cerr)
	}
	h := handlers.NewSearch(nil, store)
	require.Len(t, scopeSearchPaths(t, h, map[string]any{"query": "report", "storage_id": st.ID}), 2)
	kept := scopeSearchPaths(t, h, map[string]any{"query": "report -path:archive", "storage_id": st.ID})
	assert.Equal(t, []string{"/design/report.md"}, kept)
}

// An exclusion with no query text is a LISTING: everything on the drive except
// the excluded folder, newest first, answered by the node table rather than the
// index. It is the shape "show me everything except…" actually has.
func TestSearchExcludePath_WithoutQueryTextListsEverythingElse(t *testing.T) {
	ctx := context.Background()
	idx, err := search.Open(filepath.Join(t.TempDir(), "idx.bleve"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = idx.Close() })

	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	base := time.Now().UTC().Add(-time.Hour)
	mk := func(name, p string, age time.Duration) {
		mt := base.Add(age)
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			Type: model.NodeTypeFile, Size: 1, BackendMtime: &mt,
		})
		require.NoError(t, cerr)
		require.NoError(t, idx.IndexNode(ctx, n))
	}
	mk("old.md", "/design/old.md", 0)
	mk("new.md", "/design/new.md", time.Minute)
	mk("hidden.md", "/drafts/hidden.md", 2*time.Minute)

	h := handlers.NewSearch(idx, store)
	// An empty query with nothing to exclude is still not a search: it stays
	// the empty answer it always was, so the listing branch cannot be reached
	// by accident.
	assert.Empty(t, scopeSearchPaths(t, h, map[string]any{"query": "", "storage_id": st.ID}))

	kept := scopeSearchPaths(t, h, map[string]any{"query": "-path:drafts", "storage_id": st.ID})
	assert.Equal(t, []string{"/design/new.md", "/design/old.md"}, kept,
		"everything except the excluded folder, newest first")
}
