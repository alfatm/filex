package search

import (
	"strings"

	"context"
	"testing"

	"github.com/brf-tech/filex/backend/internal/model"
)

// seedPaths indexes one file per path, keyed by position, and hands back
// the ids so a test can name what it expects to survive.
func seedPaths(t *testing.T, idx *Index, paths ...string) {
	t.Helper()
	ctx := context.Background()
	for i, p := range paths {
		name := p[strings.LastIndex(p, "/")+1:]
		if err := idx.IndexNode(ctx, fileNode(int64(i+1), name, p, "etag")); err != nil {
			t.Fatalf("index %s: %v", p, err)
		}
	}
}

func TestSearchFiltered_ExcludePaths(t *testing.T) {
	ctx := context.Background()
	idx := newTestIndex(t)
	seedPaths(t,
		idx,
		"/demo/design/report.md",    // 1
		"/demo/archive/report.md",   // 2
		"/demo/documents/report.md", // 3
	)

	all, err := idx.SearchScoped(ctx, "report", 10, ScopeName)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("unfiltered: got %v, want all three", hitIDs(all))
	}

	kept, err := idx.SearchFiltered(ctx, "report", 10, ScopeName, &Filter{ExcludePaths: []string{"archive"}})
	if err != nil {
		t.Fatal(err)
	}
	if ids := hitIDs(kept); len(ids) != 2 || hasID(ids, 2) {
		t.Fatalf("excluding /archive: got %v, want 1 and 3", ids)
	}

	// The exclusion is a whole word run, so `doc` does not take
	// `/documents` with it — the same rule PathExcluded holds the
	// non-index branches to.
	kept, err = idx.SearchFiltered(ctx, "report", 10, ScopeName, &Filter{ExcludePaths: []string{"doc"}})
	if err != nil {
		t.Fatal(err)
	}
	if ids := hitIDs(kept); len(ids) != 3 {
		t.Fatalf("excluding /doc: got %v, want all three", ids)
	}

	// A multi-word folder is matched in order, so excluding `demo archive`
	// hides the file under it and nothing else.
	kept, err = idx.SearchFiltered(ctx, "report", 10, ScopeName, &Filter{ExcludePaths: []string{"demo archive"}})
	if err != nil {
		t.Fatal(err)
	}
	if ids := hitIDs(kept); len(ids) != 2 || hasID(ids, 2) {
		t.Fatalf("excluding /demo/archive: got %v, want 1 and 3", ids)
	}
}

// The exclusion has to reach the content pass too: a file found by what is
// INSIDE it is still a file in the folder the user rejected.
func TestSearchFiltered_ExcludePathsAppliesToContent(t *testing.T) {
	ctx := context.Background()
	idx := newTestIndex(t)
	keep := fileNode(1, "a.txt", "/demo/design/a.txt", "e1")
	drop := fileNode(2, "b.txt", "/demo/archive/b.txt", "e2")
	for _, n := range []*model.Node{keep, drop} {
		if err := idx.IndexNode(ctx, n); err != nil {
			t.Fatal(err)
		}
		if err := idx.IndexNodeContent(ctx, n, "quarterly budget"); err != nil {
			t.Fatal(err)
		}
	}
	hits, err := idx.SearchFiltered(ctx, "budget", 10, ScopeContent, &Filter{ExcludePaths: []string{"archive"}})
	if err != nil {
		t.Fatal(err)
	}
	if ids := hitIDs(hits); len(ids) != 1 || ids[0] != 1 {
		t.Fatalf("content pass: got %v, want just 1", ids)
	}
}

// An exclusion alongside a tag filter narrows twice rather than replacing
// one with the other — the two live in the same Filter and both are
// MustNot/Must clauses of one boolean.
func TestSearchFiltered_ExcludePathsWithIDFilter(t *testing.T) {
	ctx := context.Background()
	idx := newTestIndex(t)
	seedPaths(t, idx,
		"/demo/design/report.md",  // 1
		"/demo/archive/report.md", // 2
		"/demo/design/other.md",   // 3
	)
	hits, err := idx.SearchFiltered(ctx, "report", 10, ScopeName, &Filter{
		Restrict:     true,
		IncludeIDs:   []int64{1, 2},
		ExcludePaths: []string{"archive"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ids := hitIDs(hits); len(ids) != 1 || ids[0] != 1 {
		t.Fatalf("got %v, want just 1", ids)
	}
}

// hasID is contains() for node ids; the package's own contains works on
// strings.
func hasID(ids []int64, want int64) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}
