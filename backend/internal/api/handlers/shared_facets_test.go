package handlers_test

// The filter chips on shared-with-me. The set is built whole and then paged,
// so the filter has to go in BEFORE the page is cut — `total` is the filtered
// count — and a row synthesised from a grant the indexer never walked has
// nothing for a chip to test.

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func sharedWithMeQuery(t *testing.T, client *http.Client, base, query string) ([]string, int) {
	t.Helper()
	st, raw := doReq(t, client, http.MethodGet, base+"/api/files/manager/shared-with-me?"+query, nil)
	require.Equal(t, http.StatusOK, st, "shared-with-me: %s", raw)
	var out struct {
		Files []map[string]any `json:"files"`
		Total int              `json:"total"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	return pathsOf(out.Files), out.Total
}

func TestSharedWithMe_FacetsNarrowFilesAndTotal(t *testing.T) {
	srv, _, store := testutil.NewTestServer(t)
	team := seedStorage(t, store, "team", true)
	u := seedSharedUser(t, store, "u@test.local", "UserPass1!")

	seedNode(t, store, team, "plan.md", false)
	seedNode(t, store, team, "photo.png", false)
	grant(t, store, team, u, "plan.md", model.GrantViewer, false)
	grant(t, store, team, u, "photo.png", model.GrantViewer, false)
	// A grant on a path the indexer never walked: listed as a synthetic row.
	grant(t, store, team, u, "Unwalked", model.GrantViewer, true)

	client := freshClient(t)
	testutil.LoginAs(t, srv, client, "u@test.local", "UserPass1!")

	all, total := sharedWithMeQuery(t, client, srv.URL, "")
	assert.ElementsMatch(t, []string{"team://plan.md", "team://photo.png", "team://Unwalked"}, all)
	assert.Equal(t, 3, total, "with nothing asked, the grant-only row is listed too")

	md, total := sharedWithMeQuery(t, client, srv.URL, "ext=md")
	assert.Equal(t, []string{"team://plan.md"}, md)
	assert.Equal(t, 1, total, "total counts the filtered set; the grant-only row is not a .md either")

	// Filtered before paging: a page of one over the filtered set is the one
	// match, not the newest grant.
	paged, total := sharedWithMeQuery(t, client, srv.URL, "ext=png&limit=1")
	assert.Equal(t, []string{"team://photo.png"}, paged)
	assert.Equal(t, 1, total)

	byName, total := sharedWithMeQuery(t, client, srv.URL, "name=PLAN")
	assert.Equal(t, []string{"team://plan.md"}, byName)
	assert.Equal(t, 1, total)

	// The bug this guards: any chip used to drop every grant-only row, so typing
	// the name of a folder somebody had just shared with you made it vanish from
	// the page that exists to show it. A name and an extension are answerable
	// from the grant's own path, and now they are answered.
	unwalked, total := sharedWithMeQuery(t, client, srv.URL, "name=unwal")
	assert.Equal(t, []string{"team://Unwalked"}, unwalked)
	assert.Equal(t, 1, total)

	// What a path still cannot answer stays dropped: nobody knows that folder's
	// size or when it changed, so a chip asking is a chip it cannot satisfy.
	bySize, total := sharedWithMeQuery(t, client, srv.URL, "size_min=1")
	assert.NotContains(t, bySize, "team://Unwalked")
	assert.Equal(t, len(bySize), total)
}
