package search

// "Whole phrase" — the advanced form's box that had nothing behind it.
//
// The words in that order, next to each other, which is the one thing the AND
// match cannot express: it finds a document that mentions "annual" in one
// paragraph and "report" in another and calls it a hit.

import (
	"context"
	"testing"
)

func TestQuotedPhrase(t *testing.T) {
	cases := []struct {
		in    string
		want  string
		exact bool
	}{
		{`"annual report"`, "annual report", true},
		{`  "annual report"  `, "annual report", true},
		{`annual report`, "", false},
		// A mixed query is a second query language; it stays an ordinary match.
		{`report "annual meeting"`, "", false},
		{`""`, "", false},
		{`"   "`, "", false},
		{`"`, "", false},
	}
	for _, c := range cases {
		got, exact := QuotedPhrase(c.in)
		if got != c.want || exact != c.exact {
			t.Errorf("QuotedPhrase(%q) = (%q,%v), want (%q,%v)", c.in, got, exact, c.want, c.exact)
		}
	}
}

func TestSearchContent_QuotedQueryDemandsTheWordsInOrder(t *testing.T) {
	ctx := context.Background()
	idx := newTestIndex(t)

	together := fileNode(1, "a.txt", "/a.txt", "e1")
	apart := fileNode(2, "b.txt", "/b.txt", "e2")
	if err := idx.IndexNodeContent(ctx, together, "the annual report is ready"); err != nil {
		t.Fatal(err)
	}
	if err := idx.IndexNodeContent(ctx, apart, "a report on the annual meeting"); err != nil {
		t.Fatal(err)
	}

	loose, err := idx.SearchScoped(ctx, "annual report", 10, ScopeContent)
	if err != nil {
		t.Fatal(err)
	}
	if len(loose) != 2 {
		t.Fatalf("unquoted search should still find both documents, got %+v", loose)
	}

	exact, err := idx.SearchScoped(ctx, `"annual report"`, 10, ScopeContent)
	if err != nil {
		t.Fatal(err)
	}
	if len(exact) != 1 || exact[0].NodeID != 1 {
		t.Fatalf("quoted search should keep only the document with the phrase, got %+v", exact)
	}
}
