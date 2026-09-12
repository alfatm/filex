package handlers_test

// A file that was already on a storage when it was added has no node row until
// the periodic sync walks the folder. The assistant lists it (its listing comes
// from the driver), so every plan it then proposes for that file used to be
// refused by a lookup the model could do nothing about.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/pathkey"
)

// storageRoot is the directory behind the fixture's one storage.
func storageRoot(t *testing.T, store db.Store) string {
	t.Helper()
	storages, err := store.ListEnabledStorages(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, storages)
	var cfg struct {
		Root string `json:"root"`
	}
	require.NoError(t, json.Unmarshal(storages[0].ConfigJSON, &cfg))
	require.NotEmpty(t, cfg.Root)
	return cfg.Root
}

func TestAssistantPlan_TagsAFileTheCacheHasNeverSeen(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_tags", map[string]any{
			"paths": []string{"main://notes/arrived.txt"}, "tags": []string{"found"},
			"summary": "Tag the file that was already there",
		}),
		textFrame("I have proposed tagging it."),
	)
	srv, client, store := assistantFiles(t, provider)

	// On the storage, with no node row — exactly what a storage added on top of
	// existing files looks like before the first sync walk.
	require.NoError(t, os.WriteFile(filepath.Join(storageRoot(t, store), "notes", "arrived.txt"), []byte("already here"), 0o644))
	storages, err := store.ListEnabledStorages(context.Background())
	require.NoError(t, err)
	// No row, and the driver answers a missing row with an error on some
	// backends — either way there is nothing catalogued here.
	missing, _ := store.GetNodeByPath(context.Background(), storages[0].ID, pathkey.Hash(storages[0].ID, "/notes/arrived.txt"))
	require.Nil(t, missing, "the fixture must not have catalogued it")

	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "tag the file that was already there")
	card := planCard(t, events)
	items, _ := card["items"].([]any)
	require.Len(t, items, 1)
	first, _ := items[0].(map[string]any)
	assert.Equal(t, "main://notes/arrived.txt", first["path"])

	planID, _ := card["plan_id"].(string)
	require.NotEmpty(t, planID)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)

	node := nodeAt(t, store, "main://notes/arrived.txt")
	tags, err := store.GetNodeTags(context.Background(), node.ID)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"found"}, tags)
}

// The same gap on the destination side: a folder that is on the storage but not
// in the cache must not be proposed as a folder to create.
func TestAssistantPlan_MovesIntoAFolderTheCacheHasNeverSeen(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_move", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "target": "main://archive",
			"summary": "Move hello.txt into archive",
		}),
		textFrame("I have proposed the move."),
	)
	srv, client, store := assistantFiles(t, provider)
	require.NoError(t, os.MkdirAll(filepath.Join(storageRoot(t, store), "archive"), 0o755))

	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "move hello.txt into archive")
	card := planCard(t, events)
	items, _ := card["items"].([]any)
	require.Len(t, items, 1, "the folder is already there: nothing to create")
	first, _ := items[0].(map[string]any)
	assert.Equal(t, "move", first["action"])

	planID, _ := card["plan_id"].(string)
	st, raw := doReq(t, client, http.MethodPost, srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "approve: %s", raw)
	var outcome struct {
		Done int `json:"done"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Equal(t, 1, outcome.Done)
	assert.FileExists(t, filepath.Join(storageRoot(t, store), "archive", "hello.txt"))
}
