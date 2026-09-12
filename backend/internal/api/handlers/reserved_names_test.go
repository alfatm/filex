package handlers

// filex's own buckets — the trash, the version snapshots, the thumbnail cache,
// the encrypted-folder marker — were hidden in six places with three different
// rules. Two of those rules were substring tests over the PATH, so a file the
// person named `my.thumbsup.png` was hidden from the listing and from the
// assistant with no way to tell it was there; the assistant's own list knew two
// of the four names, so version snapshots were the only bucket it dropped.
//
// These tests are written from the person's side: their file stays visible, and
// the real bucket beside it does not.

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/e2e"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/trash"
	"github.com/brf-tech/filex/backend/internal/versioning"
)

// The shared list cannot import the packages that own these spellings without a
// cycle, so this is what keeps the two in step.
func TestReservedNamesAgreeWithTheOwningPackages(t *testing.T) {
	for _, name := range []string{trash.Prefix, versioning.VersionsPrefix, e2e.MarkerName, ".thumbs"} {
		assert.Contains(t, model.ReservedNames, name,
			"%q is an internal bucket its own package declares; model.ReservedNames has to list it", name)
	}
}

func basenames(rows []map[string]any) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r["basename"].(string))
	}
	return out
}

func TestProjectFileNodesKeepsAFileNamedAfterABucket(t *testing.T) {
	dir := func(name, path string) *model.Node {
		return &model.Node{Name: name, Path: path, Type: model.NodeTypeDirectory}
	}
	file := func(name, path string) *model.Node {
		return &model.Node{Name: name, Path: path, Type: model.NodeTypeFile}
	}
	rows := projectFileNodes("main", []*model.Node{
		file("my.thumbsup.png", "/Design/my.thumbsup.png"),
		file("notes.versions.md", "/Design/notes.versions.md"),
		dir(".thumbs", "/Design/.thumbs"),
		dir(".versions", "/.versions"),
		dir(".filex-trash", "/.filex-trash"),
		file("42.jpg", "/Design/.thumbs/42.jpg"),
		file(e2e.MarkerName, "/Design/"+e2e.MarkerName),
		file("logo.svg", "/Design/logo.svg"),
	}, false, nil)

	assert.Equal(t, []string{"my.thumbsup.png", "notes.versions.md", "logo.svg"}, basenames(rows),
		"a name that merely contains a bucket's spelling is the person's own file")
}

func TestProjectDriverObjectsHidesTheSameThingsAsTheCacheProjection(t *testing.T) {
	rows := projectDriverObjects("main", "/Design", []storage.Object{
		{Name: "my.thumbsup.png", Path: "/Design/my.thumbsup.png", Kind: storage.KindFile},
		{Name: ".thumbs", Path: "/Design/.thumbs", Kind: storage.KindDirectory},
		{Name: ".versions", Path: "/Design/.versions", Kind: storage.KindDirectory},
		{Name: ".filex-trash", Path: "/.filex-trash", Kind: storage.KindDirectory},
		{Name: e2e.MarkerName, Path: "/Design/" + e2e.MarkerName, Kind: storage.KindFile},
		{Name: ".keepdir", Path: "/Design/.keepdir", Kind: storage.KindFile},
		{Name: "logo.svg", Path: "/Design/logo.svg", Kind: storage.KindFile},
	}, false, nil)

	assert.Equal(t, []string{"my.thumbsup.png", "logo.svg"}, basenames(rows),
		"the cold-cache fallback and the cache projection have to answer the same question the same way")
}

func TestWithoutBookkeepingDropsEveryBucketAndNothingElse(t *testing.T) {
	kept := withoutBookkeeping([]aiEntry{
		{Name: "my.thumbsup.png", Path: "main://Design/my.thumbsup.png"},
		{Name: ".versions", Path: "main://.versions"},
		{Name: ".thumbs", Path: "main://.thumbs"},
		{Name: trash.Prefix, Path: "main://" + trash.Prefix},
		{Name: e2e.MarkerName, Path: "main://" + e2e.MarkerName},
		{Name: "logo.svg", Path: "main://Design/logo.svg"},
	})
	require.Len(t, kept, 2)
	assert.Equal(t, "my.thumbsup.png", kept[0].Name,
		"the assistant could not see this file, and the person had no way to find out why")
	assert.Equal(t, "logo.svg", kept[1].Name)
}

// A public link's own two gates: what the folder page lists, and what a rel
// path handed to it is allowed to reach. Both ran off a private three-name map
// that knew neither `.versions` nor the encrypted-folder marker — so a link to
// a folder also served, to anyone holding it, a copy of every file any surface
// had ever replaced.
func TestShareBrowseHidesBucketsAndKeepsAFileNamedAfterOne(t *testing.T) {
	for _, name := range []string{"my.thumbsup.png", "notes.versions.md", "rapor.md"} {
		assert.False(t, shareHidden(name), "%q is the person's own file", name)
	}
	for _, name := range []string{".thumbs", versioning.VersionsPrefix, trash.Prefix, e2e.MarkerName, ".keepdir"} {
		assert.True(t, shareHidden(name), "%q is bookkeeping, never served from a public link", name)
	}

	// The rel path a visitor may ask the link for, component by component.
	for _, rel := range []string{"my.thumbsup.png", "Design/notes.versions.md", "Design/logo.svg"} {
		cleaned, ok := cleanShareRel(rel)
		assert.True(t, ok, "%q names the person's own file", rel)
		assert.Equal(t, rel, cleaned)
	}
	for _, rel := range []string{".versions/42/1", "Design/.thumbs/42.jpg", trash.Prefix + "/x.md", "Design/" + e2e.MarkerName} {
		_, ok := cleanShareRel(rel)
		assert.False(t, ok, "%q reaches into a bucket and a public link never serves one", rel)
	}
}
