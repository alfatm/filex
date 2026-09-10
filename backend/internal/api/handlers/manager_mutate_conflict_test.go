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

// A move preserves the basename, so a taken name in the destination is the
// same silent overwrite rename had — os.Rename replaces the victim.
func TestManagerMutate_Move_NameTakenInDest_409_TargetBytesIntact(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)

	require.NoError(t, os.Mkdir(filepath.Join(root, "dest"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "doc.txt"), []byte("source-bytes"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "dest", "doc.txt"), []byte("victim"), 0o644))

	rec := callMutate(t, mh, "move", map[string]any{
		"path":  "main://dest",
		"items": []map[string]any{{"path": "main://doc.txt"}},
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	victim, err := os.ReadFile(filepath.Join(root, "dest", "doc.txt"))
	require.NoError(t, err)
	assert.Equal(t, "victim", string(victim), "the move target was replaced by the source")

	src, err := os.ReadFile(filepath.Join(root, "doc.txt"))
	require.NoError(t, err)
	assert.Equal(t, "source-bytes", string(src))
}

// The whole batch is checked before anything moves: one taken name must not
// leave the items ahead of it already relocated.
func TestManagerMutate_Move_BatchRefusedBeforeAnyItemMoves(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)

	require.NoError(t, os.Mkdir(filepath.Join(root, "dest"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "free.txt"), []byte("first"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "taken.txt"), []byte("second"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(root, "dest", "taken.txt"), []byte("victim"), 0o644))

	rec := callMutate(t, mh, "move", map[string]any{
		"path": "main://dest",
		"items": []map[string]any{
			{"path": "main://free.txt"},
			{"path": "main://taken.txt"},
		},
	})
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())

	// The item ahead of the collision is still at its source.
	first, err := os.ReadFile(filepath.Join(root, "free.txt"))
	require.NoError(t, err)
	assert.Equal(t, "first", string(first), "an item ahead of the collision was moved anyway")
	_, err = os.Stat(filepath.Join(root, "dest", "free.txt"))
	assert.True(t, os.IsNotExist(err), "a refused batch moved an item into the destination")
}

// Moving an item into the directory it already sits in stays a no-op.
func TestManagerMutate_Move_IntoOwnDir_StillOK(t *testing.T) {
	mh, _, _, _, root := newMutateFixture(t)

	require.NoError(t, os.WriteFile(filepath.Join(root, "stay.txt"), []byte("body"), 0o644))

	rec := callMutate(t, mh, "move", map[string]any{
		"path":  "main://",
		"items": []map[string]any{{"path": "main://stay.txt"}},
	})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	body, err := os.ReadFile(filepath.Join(root, "stay.txt"))
	require.NoError(t, err)
	assert.Equal(t, "body", string(body))
}
