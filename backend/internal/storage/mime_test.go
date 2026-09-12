package storage

import "testing"

func TestRefineMime(t *testing.T) {
	cases := []struct {
		detected string
		filename string
		want     string
	}{
		// Office ZIPs get upgraded.
		{"application/zip", "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
		{"application/zip", "letter.DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"application/zip", "budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		{"application/zip", "notes.odt", "application/vnd.oasis.opendocument.text"},
		{"application/zip", "calc.ods", "application/vnd.oasis.opendocument.spreadsheet"},
		{"application/zip", "deck.odp", "application/vnd.oasis.opendocument.presentation"},

		// Real ZIP stays a ZIP.
		{"application/zip", "archive.zip", "application/zip"},
		{"application/zip", "no-extension", "application/zip"},

		// Non-ZIP MIME passes through unchanged.
		{"image/png", "deck.pptx", "image/png"},
		{"", "deck.pptx", ""},
		{"application/octet-stream", "deck.pptx", "application/octet-stream"},

		// An SVG has no magic number, so sniffing calls it text. This is what
		// cost every .svg on a local storage its thumbnail: catalogued as
		// text/plain, it matched neither SVG branch of the thumbnail
		// dispatcher and got the generic placeholder card instead.
		{"text/plain; charset=utf-8", "logo.svg", "image/svg+xml"},
		{"text/xml; charset=utf-8", "logo.svg", "image/svg+xml"},
		{"text/plain; charset=utf-8", "LOGO.SVG", "image/svg+xml"},
		{"text/html; charset=utf-8", "logo.svg", "image/svg+xml"},

		// Only the text answers are overridden, and only for .svg: a file
		// whose BYTES are a PNG keeps image/png however it is named, and a
		// text file that is not an SVG stays text.
		{"image/png", "logo.svg", "image/png"},
		{"text/plain; charset=utf-8", "notes.txt", "text/plain; charset=utf-8"},
		{"text/plain; charset=utf-8", "no-extension", "text/plain; charset=utf-8"},
	}
	for _, c := range cases {
		got := RefineMime(c.detected, c.filename)
		if got != c.want {
			t.Errorf("RefineMime(%q, %q) = %q, want %q", c.detected, c.filename, got, c.want)
		}
	}
}
