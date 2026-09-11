package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/db"
)

// listingFacets reads the filter chips a flat listing was asked for off the
// query string.
//
// The vocabulary is the advanced search's, word for word — `ext`,
// `modified_after`, `size_min`, `size_max`, `owner_id`, plus `name` — because a client that
// has learned how to say "documents modified this week" to `/search` should
// not have to learn a second way to say it to `/manager/recent`. Extensions
// rather than a type-group name for the same reason as there: which extensions
// count as "documents" is the client's vocabulary, and a copy of that taxonomy
// here is a copy to keep in step.
//
// They matter because these listings are capped. Applied to the page instead of
// inside the query, a filter answers with the matches among the newest N rows
// and gives no sign that it is not the whole answer — "no images in your
// starred files" when there are images, just not in the first five hundred.
func listingFacets(r *http.Request) db.NodeFacets {
	q := r.URL.Query()
	f := db.NodeFacets{}
	// `ext=md&ext=pdf`, and a comma-separated list as well: both spellings turn
	// up in hand-written requests and neither is ambiguous.
	for _, raw := range q["ext"] {
		for _, ext := range strings.Split(raw, ",") {
			if ext = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(ext, "."))); ext != "" {
				f.Exts = append(f.Exts, ext)
			}
		}
	}
	if ms := facetInt(q.Get("modified_after")); ms > 0 {
		t := time.UnixMilli(ms).UTC()
		f.ModifiedAfter = &t
	}
	// The upper edge of the same window. The details panel asks for "written
	// within a day either side of this row", which needs both bounds; a client
	// that sends only one still gets the open-ended filter it asked for.
	if ms := facetInt(q.Get("modified_before")); ms > 0 {
		t := time.UnixMilli(ms).UTC()
		f.ModifiedBefore = &t
	}
	if ms := facetInt(q.Get("created_after")); ms > 0 {
		t := time.UnixMilli(ms).UTC()
		f.CreatedAfter = &t
	}
	if ms := facetInt(q.Get("created_before")); ms > 0 {
		t := time.UnixMilli(ms).UTC()
		f.CreatedBefore = &t
	}
	// `tag=a&tag=b`, or one comma-separated value — the same two spellings
	// `ext` takes, and the same AND between them: every tag listed has to be on
	// the node. Lower-cased because that is the only shape SetNodeTags stores.
	for _, raw := range q["tag"] {
		for _, tag := range strings.Split(raw, ",") {
			if tag = strings.ToLower(strings.TrimSpace(tag)); tag != "" {
				f.Tags = append(f.Tags, tag)
			}
		}
	}
	if v := facetInt(q.Get("size_min")); v > 0 {
		f.SizeMin = &v
	}
	// A ceiling of zero bytes is not a filter anyone asks for, so 0 reads as
	// "no ceiling" and the parameter can simply be left out.
	if v := facetInt(q.Get("size_max")); v > 0 {
		f.SizeMax = &v
	}
	if v := facetInt(q.Get("owner_id")); v > 0 {
		f.OwnerID = &v
	}
	// `name` is a case-insensitive substring of the file name — the toolbar's
	// quick filter, not the search box: it does not read contents or paths.
	f.NameContains = strings.TrimSpace(q.Get("name"))
	// A filter on extension or size is a filter for files: a folder has no
	// extension and its size is a rollup of its subtree. A date or an owner
	// keeps folders.
	f.FilesOnly = len(f.Exts) > 0 || f.SizeMin != nil || f.SizeMax != nil
	return f
}

// facetInt reads a non-negative integer parameter; anything unparseable is
// treated as absent, the way an omitted filter is.
func facetInt(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}
