package model

import "strings"

// ReservedNames are filex's own buckets inside a storage: the trash every
// account's deletions land in, the version snapshots, the thumbnail cache and
// the encrypted-folder marker. They are bookkeeping, not the person's files, so
// every listing, every count and every download drops them.
//
// The list lives here — in the leaf package everything already depends on —
// because it used to live in six places with three different comparison rules,
// and each copy answered "is this ours?" differently: the two drivers matched
// exact names, one listing projection mixed names with substrings of the path,
// the assistant knew two of the four names, and the archive walker had its own
// map. The canonical spellings are also declared as trash.Prefix,
// versioning.VersionsPrefix and e2e.MarkerName, which cannot be imported from
// here without a cycle; reservedNamesMatchTheirPackages in the handlers tests
// asserts they still agree.
var ReservedNames = []string{".filex-trash", ".versions", ".thumbs", ".filex-e2e.json"}

// IsReservedPath reports whether a storage-relative path names one of those
// buckets or lives anywhere beneath one.
//
// ⚠ Matched per path COMPONENT, never as a substring. `strings.Contains(p,
// ".thumbs")` hides a file the person named `my.thumbsup.png` — from the
// listing, from the assistant, from a zip of the folder — and gives no sign it
// did. A component test hides `a/.thumbs/x.jpg` and nothing else.
func IsReservedPath(rel string) bool {
	for _, part := range strings.Split(strings.Trim(rel, "/"), "/") {
		for _, name := range ReservedNames {
			if part == name {
				return true
			}
		}
	}
	return false
}
