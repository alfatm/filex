package handlers_test

// The client contract says createFolder and rename answer 409 on a name
// collision (app/src/data/http/repository.ts maps that status to
// DUPLICATE_NAME, and the rename/new-folder modals render it inline). The
// server did not: newfolder ran MkdirAll over an existing folder and answered
// 200, and rename went straight to os.Rename, which on Linux SILENTLY REPLACES
// the file already sitting at the destination.
//
// Both tests assert the state left behind after the refusal, not just the
// status: the folder that was already there must be untouched, and the bytes
// of the file that was about to be clobbered must still be its own.

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestManagerMutate_NewFolder_NameTakenByFolder_409(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)

	// Somebody else's folder, with something in it so "untouched" is provable.
	require.NoError(t, os.Mkdir(filepath.Join(root, "alpha"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "alpha", "keep.txt"), []byte("mine"), 0o644))

	rec := callMutate(t, mh, "newfolder", map[string]any{
		"path": "main://",
		"name": "alpha",
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	// The existing folder and its content survived the refusal.
	info, err := os.Stat(filepath.Join(root, "alpha"))
	require.NoError(t, err)
	assert.True(t, info.IsDir())
	kept, err := os.ReadFile(filepath.Join(root, "alpha", "keep.txt"))
	require.NoError(t, err)
	assert.Equal(t, "mine", string(kept))
}

func TestManagerMutate_Rename_NameTakenByOtherFile_409_TargetBytesIntact(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)

	require.NoError(t, os.WriteFile(filepath.Join(root, "src.txt"), []byte("source-bytes"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "dst.txt"), []byte("victim"), 0o644))

	rec := callMutate(t, mh, "rename", map[string]any{
		"path": "main://",
		"item": "main://src.txt",
		"name": "dst.txt",
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	// The point of the test: os.Rename would have overwritten these bytes.
	victim, err := os.ReadFile(filepath.Join(root, "dst.txt"))
	require.NoError(t, err)
	assert.Equal(t, "victim", string(victim), "the rename target was replaced by the source")

	// And the source is still where it was — a refused rename moves nothing.
	src, err := os.ReadFile(filepath.Join(root, "src.txt"))
	require.NoError(t, err)
	assert.Equal(t, "source-bytes", string(src))
}

// Renaming an item to the name it already has stays a no-op, not a self-collision.
func TestManagerMutate_Rename_SameName_StillOK(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)

	require.NoError(t, os.WriteFile(filepath.Join(root, "same.txt"), []byte("body"), 0o644))

	rec := callMutate(t, mh, "rename", map[string]any{
		"path": "main://",
		"item": "main://same.txt",
		"name": "same.txt",
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	body, err := os.ReadFile(filepath.Join(root, "same.txt"))
	require.NoError(t, err)
	assert.Equal(t, "body", string(body))
}
