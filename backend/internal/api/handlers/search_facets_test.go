package handlers_test

// The facet half of a search.
//
// The full-text index knows a document's name, path, mime and type, and nothing
// else — no size, no date, no owner. So a query with a filter used to be
// answered by taking the first N hits for the TEXT and throwing away the ones
// outside the filter: if the three files the user wanted ranked two hundredth,
// they saw nothing, and could not tell that from "there are none".
//
// The facets are resolved against the node table instead and applied as a
// restriction on which documents the index may return — the mechanism `tag:`
// already used — plus an exact pass over the results, which is what makes the
// answer right on the two paths that never consult the index at all.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

type facetFixture struct {
	store db.Store
	h     *handlers.Search
	st    *model.Storage
}

func newFacetFixture(t *testing.T) *facetFixture {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(context.Background(), &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	// No index wired: the SQL LIKE fallback answers, which is exactly the path
	// a facet could silently do nothing on.
	return &facetFixture{store: store, h: handlers.NewSearch(nil, store), st: st}
}

func (f *facetFixture) seed(t *testing.T, name string, size int64, mtime time.Time, owner *int64) *model.Node {
	t.Helper()
	clean := "/" + name
	n, err := f.store.CreateNode(context.Background(), &model.Node{
		StorageID: f.st.ID, Name: name, Path: clean, PathHash: pathkey.Hash(f.st.ID, clean),
		Type: model.NodeTypeFile, Size: size, BackendMtime: &mtime,
	})
	require.NoError(t, err)
	if owner != nil {
		require.NoError(t, f.store.SetNodeOwner(context.Background(), n.ID, owner))
	}
	return n
}

func (f *facetFixture) search(t *testing.T, body map[string]any) []string {
	t.Helper()
	body["storage_id"] = f.st.ID
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/files/search", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.h.Search(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out struct {
		Results []struct {
			Name string `json:"name"`
		} `json:"results"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	names := make([]string, 0, len(out.Results))
	for _, r := range out.Results {
		names = append(names, r.Name)
	}
	return names
}

func TestSearchFacets_NarrowByDateSizeExtensionAndOwner(t *testing.T) {
	f := newFacetFixture(t)
	now := time.Now().UTC().Truncate(time.Second)
	old := now.AddDate(0, 0, -90)

	ayse, err := f.store.CreateUser(context.Background(), "ayse@filex.test", "x", "user", "tr", "UTC")
	require.NoError(t, err)

	f.seed(t, "rapor-yeni.md", 1000, now, &ayse.ID)
	f.seed(t, "rapor-eski.md", 1000, old, &ayse.ID)
	f.seed(t, "rapor-buyuk.md", 50_000_000, now, nil)
	f.seed(t, "rapor.pdf", 1000, now, &ayse.ID)

	// Unfiltered: everything the text matches.
	require.Len(t, f.search(t, map[string]any{"query": "rapor"}), 4)

	// A date window drops the old one.
	within := f.search(t, map[string]any{"query": "rapor", "modified_after": now.AddDate(0, 0, -7).UnixMilli()})
	require.ElementsMatch(t, []string{"rapor-yeni.md", "rapor-buyuk.md", "rapor.pdf"}, within)

	// A size ceiling drops the big one.
	small := f.search(t, map[string]any{"query": "rapor", "size_max": 1_000_000})
	require.ElementsMatch(t, []string{"rapor-yeni.md", "rapor-eski.md", "rapor.pdf"}, small)

	// Extensions come from the client, so "documents" stays the client's word.
	md := f.search(t, map[string]any{"query": "rapor", "ext": []string{"md"}})
	require.ElementsMatch(t, []string{"rapor-yeni.md", "rapor-eski.md", "rapor-buyuk.md"}, md)

	// An owner, including the file nobody owns being excluded rather than kept.
	hers := f.search(t, map[string]any{"query": "rapor", "owner_id": ayse.ID})
	require.ElementsMatch(t, []string{"rapor-yeni.md", "rapor-eski.md", "rapor.pdf"}, hers)

	// Facets narrow together, never widen.
	both := f.search(t, map[string]any{
		"query": "rapor", "ext": []string{"md"}, "modified_after": now.AddDate(0, 0, -7).UnixMilli(), "size_max": 1_000_000,
	})
	require.Equal(t, []string{"rapor-yeni.md"}, both)
}

func TestSearchFacets_PathPrefixConfinesToASubtree(t *testing.T) {
	f := newFacetFixture(t)
	now := time.Now().UTC()
	mk := func(path string) {
		clean := "/" + path
		_, err := f.store.CreateNode(context.Background(), &model.Node{
			StorageID: f.st.ID, Name: path[len(path)-len("rapor.md"):], Path: clean,
			PathHash: pathkey.Hash(f.st.ID, clean), Type: model.NodeTypeFile, BackendMtime: &now,
		})
		require.NoError(t, err)
	}
	mk("Docs/rapor.md")
	mk("Arsiv/rapor.md")

	// "Search in the current folder" — the one advanced-search control that had
	// no server-side expression at all before this.
	require.Len(t, f.search(t, map[string]any{"query": "rapor"}), 2)
	require.Len(t, f.search(t, map[string]any{"query": "rapor", "path_prefix": "/Docs"}), 1)
}

func TestSearchFacets_AFilterThatMatchesNothingAnswersNothing(t *testing.T) {
	f := newFacetFixture(t)
	now := time.Now().UTC()
	f.seed(t, "rapor.md", 1000, now, nil)

	// Not "ignore the filter and return everything", which is what a filter
	// resolving to an empty set would mean if it were treated as absent.
	require.Empty(t, f.search(t, map[string]any{"query": "rapor", "ext": []string{"xlsx"}}))
}

// The destination picker's filter box. Its tree loads one level at a time, so
// without a way to ask "which FOLDERS on this drive are called that", the box
// could only search the levels somebody had already opened — which is the same
// as not having one.
func TestSearchFacets_DirsOnlyAnswersFoldersAndTheContradictionAnswersNothing(t *testing.T) {
	f := newFacetFixture(t)
	now := time.Now().UTC().Truncate(time.Second)

	// A folder and a file whose names both match, so only the facet separates them.
	dir, err := f.store.CreateNode(context.Background(), &model.Node{
		StorageID: f.st.ID, Name: "Belgeler", Path: "/Belgeler", PathHash: pathkey.Hash(f.st.ID, "/Belgeler"),
		Type: model.NodeTypeDirectory, BackendMtime: &now,
	})
	require.NoError(t, err)
	require.NotZero(t, dir.ID)
	f.seed(t, "Belgeler.pdf", 10, now, nil)

	require.Equal(t, []string{"Belgeler"}, f.search(t, map[string]any{"query": "Belgeler", "dirs_only": true}))
	// Both, when nothing asks for one or the other.
	require.ElementsMatch(t, []string{"Belgeler", "Belgeler.pdf"}, f.search(t, map[string]any{"query": "Belgeler"}))
	// A folder with an extension is a contradiction. Answering it with nothing
	// is more honest than quietly picking whichever half came last.
	require.Empty(t, f.search(t, map[string]any{"query": "Belgeler", "dirs_only": true, "ext": []string{"pdf"}}))
}
