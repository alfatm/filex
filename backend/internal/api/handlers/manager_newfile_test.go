package handlers_test

// POST /api/files/manager?action=newfile — the explorer's "new document"
// verb. Same fixture as the other mutation verbs (manager_mutate_test.go): a
// real local driver on a temp dir plus the in-memory store, so both the
// on-disk effect and the cache row are asserted.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
)

func TestManagerMutate_NewFile_OK(t *testing.T) {
	mh, store, _, st, root := newMutateFixture(t)

	rec := callMutate(t, mh, "newfile", map[string]any{
		"path": "main://",
		"name": "notes.md",
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// Driver: a zero-byte regular file.
	info, err := os.Stat(filepath.Join(root, "notes.md"))
	require.NoError(t, err)
	assert.False(t, info.IsDir())
	assert.Zero(t, info.Size())

	// DB cache: a file row, empty, typed from the extension.
	n, err := store.GetNodeByPath(context.Background(), st.ID, mutTestPathHash(st.ID, "/notes.md"))
	require.NoError(t, err)
	require.NotNil(t, n)
	assert.Equal(t, model.NodeTypeFile, n.Type)
	assert.Equal(t, "notes.md", n.Name)
	assert.Zero(t, n.Size)
	assert.Contains(t, n.Mime, "text/markdown")

	// Response: the re-rendered parent listing, like newfolder.
	var resp map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	assert.Equal(t, "main", resp["adapter"])
}

// A second file of the same name must not truncate the first: Write
// overwrites, so the name guard has to answer 409 before it runs.
func TestManagerMutate_NewFile_Duplicate_409(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)
	require.NoError(t, os.WriteFile(filepath.Join(root, "keep.txt"), []byte("do not lose me"), 0o644))

	rec := callMutate(t, mh, "newfile", map[string]any{"path": "main://", "name": "keep.txt"})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	got, err := os.ReadFile(filepath.Join(root, "keep.txt"))
	require.NoError(t, err)
	assert.Equal(t, "do not lose me", string(got), "the existing file was overwritten")
}

func TestManagerMutate_NewFile_BadName_400(t *testing.T) {
	mh, _, _, _, _ := newMutateFixture(t)
	rec := callMutate(t, mh, "newfile", map[string]any{"path": "main://", "name": "with/slash"})
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "bad file name")
}

// A folder already holding the name is the same collision from the other kind.
func TestManagerMutate_NewFile_OverFolder_409(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)
	require.NoError(t, os.Mkdir(filepath.Join(root, "docs"), 0o755))

	rec := callMutate(t, mh, "newfile", map[string]any{"path": "main://", "name": "docs"})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	info, err := os.Stat(filepath.Join(root, "docs"))
	require.NoError(t, err)
	assert.True(t, info.IsDir(), "the folder was replaced by a file")
}
