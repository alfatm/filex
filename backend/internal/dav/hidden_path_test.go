package dav

// The protocol surfaces hide filex's own buckets — the trash, the version
// snapshots, the thumbnail cache, the encrypted-folder marker. Each of /dav,
// /ftp, /sftp, /nfs and the S3 gateway used to carry its own copy of that list,
// and every copy knew three of the four names.
//
// The test below is written from the person's side: a file they named after a
// bucket is theirs and stays reachable, and the bucket beside it does not.

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/brf-tech/filex/backend/internal/e2e"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/trash"
	"github.com/brf-tech/filex/backend/internal/versioning"
)

func TestHiddenPathMatchesWholeComponents(t *testing.T) {
	for _, tc := range []struct {
		rel  string
		want bool
	}{
		{"Design/my.thumbsup.png", false},
		{"Design/notes.versions.md", false},
		{"my.filex-trash-notes.txt", false},
		{"Design", false},
		{"", false},

		{".thumbs", true},
		{"Design/.thumbs/42.jpg", true},
		{versioning.VersionsPrefix + "/42/1", true},
		{trash.Prefix + "/1700000000-ab__rapor.md", true},
		// The fourth name no protocol's private copy carried.
		{"Design/" + e2e.MarkerName, true},
	} {
		assert.Equal(t, tc.want, hiddenPath(tc.rel), "hiddenPath(%q)", tc.rel)
	}

	// And the same rule reaches a single listing entry, which is how the
	// directory listing drops a bucket without dropping the file beside it.
	assert.False(t, hiddenPath("my.thumbsup.png"))
	assert.True(t, hiddenPath(".thumbs"))
	assert.Contains(t, model.ReservedNames, ".thumbs")
}
