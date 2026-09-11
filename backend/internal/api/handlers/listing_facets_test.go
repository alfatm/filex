package handlers

// The filter chips as query parameters. The vocabulary is the advanced
// search's, so the tests read as the two spellings a client might send and the
// one meaning both have to carry.

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func facetsOf(t *testing.T, query string) (f struct {
	Exts     []string
	Modified *time.Time
	Min, Max *int64
	Owner    *int64
	Files    bool
}) {
	t.Helper()
	got := listingFacets(httptest.NewRequest("GET", "/manager/star/list?"+query, nil))
	f.Exts, f.Modified, f.Min, f.Max, f.Owner, f.Files = got.Exts, got.ModifiedAfter, got.SizeMin, got.SizeMax, got.OwnerID, got.FilesOnly
	return
}

func TestListingFacets_ExtensionsBothSpellings(t *testing.T) {
	repeated := facetsOf(t, "ext=md&ext=PDF")
	commas := facetsOf(t, "ext=.md,pdf")
	assert.Equal(t, []string{"md", "pdf"}, repeated.Exts, "lower-cased, dot-less")
	assert.Equal(t, repeated.Exts, commas.Exts, "a comma-separated list means the same thing")
	assert.True(t, repeated.Files, "an extension filter is a filter for files")
}

func TestListingFacets_NumbersAndTheirAbsence(t *testing.T) {
	f := facetsOf(t, "modified_after=1757376000000&size_min=1048576&size_max=104857600&owner_id=7")
	require.NotNil(t, f.Modified)
	assert.Equal(t, int64(1757376000000), f.Modified.UnixMilli())
	require.NotNil(t, f.Min)
	require.NotNil(t, f.Max)
	require.NotNil(t, f.Owner)
	assert.Equal(t, int64(1048576), *f.Min)
	assert.Equal(t, int64(104857600), *f.Max)
	assert.Equal(t, int64(7), *f.Owner)
	assert.True(t, f.Files, "a size filter is a filter for files")

	// A ceiling of zero is not a filter anyone asks for, and neither is a
	// garbled one: both read as "no filter" rather than as "nothing matches".
	empty := facetsOf(t, "size_max=0&owner_id=abc&modified_after=-5")
	assert.Nil(t, empty.Max)
	assert.Nil(t, empty.Owner)
	assert.Nil(t, empty.Modified)
	assert.False(t, empty.Files)
}

func TestListingFacets_DateAndOwnerKeepFolders(t *testing.T) {
	f := facetsOf(t, "modified_after=1757376000000&owner_id=7")
	assert.False(t, f.Files,
		"a folder has a date and an owner, so neither chip is a reason to drop it — only type and size are")
}

func TestListingFacets_NameIsTrimmedAndKeepsFolders(t *testing.T) {
	f := listingFacets(httptest.NewRequest("GET", "/manager?q=index&name=%20rep%20", nil))
	assert.Equal(t, "rep", f.NameContains)
	assert.False(t, f.FilesOnly, "a folder has a name, so the chip keeps folders")
	assert.True(t, f.Any())
	assert.Empty(t, listingFacets(httptest.NewRequest("GET", "/manager?q=index&name=%20", nil)).NameContains,
		"blank is unset")
}

func TestListingFacets_NothingAskedNarrowsNothing(t *testing.T) {
	assert.False(t, listingFacets(httptest.NewRequest("GET", "/manager/recent?limit=200", nil)).Any())
}

func TestListingFacets_DateWindowHasBothEdges(t *testing.T) {
	f := listingFacets(httptest.NewRequest("GET",
		"/manager/star/list?modified_after=1757376000000&modified_before=1757548800000", nil))
	require.NotNil(t, f.ModifiedAfter)
	require.NotNil(t, f.ModifiedBefore)
	assert.Equal(t, int64(1757376000000), f.ModifiedAfter.UnixMilli())
	assert.Equal(t, int64(1757548800000), f.ModifiedBefore.UnixMilli())
	assert.False(t, f.FilesOnly, "a folder has a date, so the window keeps folders")

	created := listingFacets(httptest.NewRequest("GET",
		"/manager/star/list?created_after=1757376000000&created_before=1757548800000", nil))
	require.NotNil(t, created.CreatedAfter)
	require.NotNil(t, created.CreatedBefore)
	assert.Equal(t, int64(1757376000000), created.CreatedAfter.UnixMilli())
	assert.Equal(t, int64(1757548800000), created.CreatedBefore.UnixMilli())
	assert.True(t, created.Any())

	assert.Nil(t, listingFacets(httptest.NewRequest("GET", "/manager/star/list?modified_before=-1", nil)).ModifiedBefore,
		"a garbled bound reads as no bound, the way an omitted one does")
}

func TestListingFacets_TagsBothSpellings(t *testing.T) {
	repeated := listingFacets(httptest.NewRequest("GET", "/manager/star/list?tag=Design&tag=q3", nil))
	commas := listingFacets(httptest.NewRequest("GET", "/manager/star/list?tag=design,%20q3", nil))
	assert.Equal(t, []string{"design", "q3"}, repeated.Tags, "lower-cased, the only shape tags are stored in")
	assert.Equal(t, repeated.Tags, commas.Tags)
	assert.False(t, repeated.FilesOnly, "a folder can carry a tag")
	assert.True(t, repeated.Any())
	assert.Empty(t, listingFacets(httptest.NewRequest("GET", "/manager/star/list?tag=%20,", nil)).Tags, "blank is unset")
}
