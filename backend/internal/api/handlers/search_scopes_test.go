package handlers_test

// The three search modes the form offered and the server did not have.
//
// `scope` knew "name", "content" and "all", and everything else fell through
// to "all" — so "Paths" also read what was inside a file, "Tags" searched every
// field there is, and "Search in → Shared files" narrowed nothing at all. Each
// test here is the same shape: the unfiltered query first, so what the mode
// drops is visible, and then the mode.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/search"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// scopeSearch posts one query straight at the handler and returns the names it
// answered with.
func scopeSearch(t *testing.T, h *handlers.Search, body map[string]any) []string {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/api/files/search", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Search(rec, req)
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

// "Paths" is the file's ADDRESS — its name and every folder above it — and
// never what is inside it. A folder hit proves it is the path being read; the
// content-only file dropping out is what the mode is FOR.
func TestSearchScope_PathsReadTheAddressAndNotTheContents(t *testing.T) {
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
	mk("tasarim.png", "/tasarim.png") // the word is the filename
	mk("plan.md", "/Tasarim/plan.md") // …and here it is a folder above it
	notes := mk("notlar.txt", "/notlar.txt")
	// The word appears only INSIDE this one.
	require.NoError(t, idx.IndexNodeContent(ctx, notes, "tasarim toplantısı notları"))

	h := handlers.NewSearch(idx, store)
	all := scopeSearch(t, h, map[string]any{"query": "tasarim", "storage_id": st.ID})
	require.ElementsMatch(t, []string{"tasarim.png", "plan.md", "notlar.txt"}, all,
		"unscoped: names, folders and contents all answer")

	paths := scopeSearch(t, h, map[string]any{"query": "tasarim", "storage_id": st.ID, "scope": "path"})
	assert.ElementsMatch(t, []string{"tasarim.png", "plan.md"}, paths,
		"the file whose only match is inside it is not a match for a path search")
	// The plural spelling is the one the form has; both mean the same mode.
	assert.ElementsMatch(t, paths, scopeSearch(t, h, map[string]any{"query": "tasarim", "storage_id": st.ID, "scope": "paths"}))
}

// "Tags" reads the tags and nothing else: a file merely CALLED "tasarim" is not
// a file tagged with it.
func TestSearchScope_TagsReadTheTagsAndNotTheName(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	mk := func(name string, tags ...string) *model.Node {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			Type: model.NodeTypeFile, Size: 10,
		})
		require.NoError(t, cerr)
		if len(tags) > 0 {
			require.NoError(t, store.SetNodeTags(ctx, n.ID, tags))
		}
		return n
	}
	mk("tasarim.md")           // the word is its NAME, and it carries no tag
	mk("belge.pdf", "tasarim") // …and here it is the tag, on a file named nothing like it
	mk("diger.txt", "arsiv")

	// No index: the SQL LIKE fallback answers, which is the path a mode can
	// most easily do nothing on.
	h := handlers.NewSearch(nil, store)
	all := scopeSearch(t, h, map[string]any{"query": "tasarim", "storage_id": st.ID})
	require.Equal(t, []string{"tasarim.md"}, all, "unscoped, the word is read as a filename")

	tagged := scopeSearch(t, h, map[string]any{"query": "tasarim", "storage_id": st.ID, "scope": "tags"})
	assert.Equal(t, []string{"belge.pdf"}, tagged,
		"the tagged file, and only it: the filename must not answer a tag search")

	// The text describes a tag rather than naming one exactly, so a prefix of it
	// finds the same file — and a tag nobody applied finds nothing rather than
	// falling back to a name search.
	assert.Equal(t, []string{"belge.pdf"}, scopeSearch(t, h, map[string]any{"query": "tasa", "storage_id": st.ID, "scope": "tags"}))
	assert.Empty(t, scopeSearch(t, h, map[string]any{"query": "boyleBirEtiketYok", "storage_id": st.ID, "scope": "tags"}))
}

// "Search in → Shared files": only the files the caller has published a link
// to, and only while that link still opens.
func TestSearchSharedOnly_NarrowsToLiveLinks(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	mk := func(name string) *model.Node {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			Type: model.NodeTypeFile, Size: 10,
		})
		require.NoError(t, cerr)
		return n
	}
	live, expired := mk("rapor-paylasilan.md"), mk("rapor-suresi-gecmis.md")
	mk("rapor-ozel.md") // never shared at all
	future, past := time.Now().Add(time.Hour), time.Now().Add(-time.Hour)
	_, err = store.CreateShare(ctx, &model.Share{NodeID: live.ID, Token: "t-live", ExpiresAt: &future})
	require.NoError(t, err)
	// A link that no longer opens is not a shared file — the same liveness test
	// the badge on a listing row applies.
	_, err = store.CreateShare(ctx, &model.Share{NodeID: expired.ID, Token: "t-exp", ExpiresAt: &past})
	require.NoError(t, err)

	h := handlers.NewSearch(nil, store)
	all := scopeSearch(t, h, map[string]any{"query": "rapor", "storage_id": st.ID})
	require.ElementsMatch(t, []string{"rapor-paylasilan.md", "rapor-suresi-gecmis.md", "rapor-ozel.md"}, all)

	shared := scopeSearch(t, h, map[string]any{"query": "rapor", "storage_id": st.ID, "shared_only": true})
	assert.Equal(t, []string{"rapor-paylasilan.md"}, shared)
}

// The store-level half of the same question: the facet narrows INSIDE the
// query, so a capped answer is a page of the shared files rather than the
// shared files among a page.
func TestNodeFacets_SharedOnlyNarrowsInTheQuery(t *testing.T) {
	ctx := context.Background()
	_, store := testutil.NewTestDB(t)
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"/tmp"}`),
	})
	require.NoError(t, err)
	mk := func(name string) *model.Node {
		p := "/" + name
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: name, Path: p, PathHash: pathkey.Hash(st.ID, p),
			Type: model.NodeTypeFile, Size: 10,
		})
		require.NoError(t, cerr)
		return n
	}
	a, b := mk("a.md"), mk("b.md")
	future := time.Now().Add(time.Hour)
	_, err = store.CreateShare(ctx, &model.Share{NodeID: b.ID, Token: "t", ExpiresAt: &future})
	require.NoError(t, err)

	unfiltered, err := store.ListNodeIDsMatching(ctx, st.ID, db.NodeFacets{}, 50)
	require.NoError(t, err)
	require.ElementsMatch(t, []int64{a.ID, b.ID}, unfiltered)

	only, err := store.ListNodeIDsMatching(ctx, st.ID, db.NodeFacets{SharedOnly: true}, 50)
	require.NoError(t, err)
	assert.Equal(t, []int64{b.ID}, only)
}
