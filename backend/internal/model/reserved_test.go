package model_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/brf-tech/filex/backend/internal/model"
)

// The rule the six call sites share. The cases that matter are the ones a
// substring test got wrong: a file whose NAME merely contains a bucket's
// spelling is the person's file and has to stay visible.
func TestIsReservedPathMatchesWholeComponents(t *testing.T) {
	for path, want := range map[string]bool{
		".thumbs":                 true,
		"/.versions":              true,
		"a/.filex-trash/x.txt":    true,
		"/Design/.versions/7/1":   true,
		".filex-e2e.json":         true,
		"my.thumbsup.png":         false,
		"Design/my.thumbsup.png":  false,
		"notes.versions.md":       false,
		"a/.versionsfoo/b.txt":    false,
		"/Design/logo.svg":        false,
		"":                        false,
		"/":                       false,
		"thumbs":                  false,
		"a/filex-trash/still.txt": false,
	} {
		assert.Equal(t, want, model.IsReservedPath(path), "IsReservedPath(%q)", path)
	}
}
