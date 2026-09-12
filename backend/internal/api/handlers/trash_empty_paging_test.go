package handlers_test

// "Empty trash" on a SHARED instance.
//
// The trash listing is ordered by deletion time across every account, and the
// permission check runs on the rows it hands back. EmptySelf used to ask for
// the first page only, so once other people's deletions filled that page the
// answer was `purged: 0, skipped: 500` on every attempt and the caller's own
// older entries were never reached. The app stops asking the moment a round
// purges nothing, so the button did nothing at all — silently, with a 200.
//
// Written from the perspective of the account that owns exactly one entry
// buried under a page of somebody else's: it must come out, and the entries it
// holds no grant on must be exactly as they were.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/api/handlers"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/storage"
	"github.com/brf-tech/filex/backend/internal/storage/drivers/local"
	"github.com/brf-tech/filex/backend/internal/testutil"
	"github.com/brf-tech/filex/backend/internal/trash"
)

func TestTrashEmptySelf_ReachesPastAPageOfOtherPeoplesDeletions(t *testing.T) {
	ctx := context.Background()
	conn, store := testutil.NewTestDB(t)
	root := t.TempDir()

	drv := &local.Driver{}
	require.NoError(t, drv.Init(ctx, map[string]any{"root": root}))
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "main", Driver: "local", MountPath: "/main", Enabled: true, RBACEnabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + escapeJSON(root) + `"}`),
	})
	require.NoError(t, err)

	// Not an admin: an admin is Owner everywhere and would purge the whole
	// deployment's trash, which says nothing about the starvation.
	me, err := store.CreateUser(ctx, "benim@filex.test", "x", model.RoleUser, "en", "UTC")
	require.NoError(t, err)
	_, err = store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: st.ID, UserID: me.ID, PathPrefix: "Benim", Level: "editor",
	})
	require.NoError(t, err)

	// A full page of deletions this account holds nothing on. `trashEmptyMax`
	// is 500 and is not exported, so the fixture states the number it is
	// standing in front of.
	const otherPeople = 500
	var firstForeign int64
	for i := 0; i < otherPeople; i++ {
		p := fmt.Sprintf("/Baskasi/dosya-%03d.md", i)
		n, cerr := store.CreateNode(ctx, &model.Node{
			StorageID: st.ID, Name: filepath.Base(p), Path: p,
			PathHash: pathkey.Hash(st.ID, p), StorageKey: p, Type: model.NodeTypeFile,
		})
		require.NoError(t, cerr)
		require.NoError(t, store.SoftDeleteNode(ctx, n.ID))
		if i == 0 {
			firstForeign = n.ID
		}
	}

	// The caller's own entry, deleted earlier than all of those — so the
	// listing's `deleted_at DESC` puts it strictly behind the whole page.
	const mine = "Benim/notlar.md"
	abs := filepath.Join(root, filepath.FromSlash(mine))
	require.NoError(t, os.MkdirAll(filepath.Dir(abs), 0o755))
	require.NoError(t, os.WriteFile(abs, []byte("benim icerigim"), 0o644))
	own, err := store.CreateNode(ctx, &model.Node{
		StorageID: st.ID, Name: "notlar.md", Path: "/" + mine,
		PathHash: pathkey.Hash(st.ID, "/"+mine), StorageKey: "/" + mine,
		Type: model.NodeTypeFile, Size: 14,
	})
	require.NoError(t, err)
	put, err := trash.Put(ctx, drv, mine)
	require.NoError(t, err)
	require.True(t, put.Trashed)
	trashKey := "/" + put.Key
	require.NoError(t, store.SoftDeleteAndRetag(ctx, own.ID, trashKey, pathkey.Hash(st.ID, trashKey), "/"+mine))
	_, err = conn.ExecContext(ctx, `UPDATE nodes SET deleted_at = datetime('now', '-2 days') WHERE id = ?`, own.ID)
	require.NoError(t, err)

	svc := trash.New(store, func(int64) (storage.Driver, error) { return drv, nil }, nil)
	h := handlers.NewTrash(svc, store)
	h.AttachACL(acl.New(store))

	// The setup is only interesting if the first page really does hide the
	// caller's entry — otherwise the test would pass on the old code too.
	page, _, err := svc.List(ctx, nil, true, db.NodeFacets{}, otherPeople, 0)
	require.NoError(t, err)
	require.Len(t, page, otherPeople)
	for _, e := range page {
		require.NotEqual(t, own.ID, e.ID, "the caller's own entry must sit below the first page")
	}

	req := httptest.NewRequest(http.MethodPost, "/manager/trash/empty", nil)
	rec := httptest.NewRecorder()
	h.EmptySelf(rec, req.WithContext(auth.WithUser(req.Context(), me)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var got struct {
		Purged  int  `json:"purged"`
		Failed  int  `json:"failed"`
		Skipped int  `json:"skipped"`
		More    bool `json:"more"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, 1, got.Purged, "the entry below the page of strangers is the whole point")
	assert.Zero(t, got.Failed)
	assert.Equal(t, otherPeople, got.Skipped, "everything it may not purge is skipped, not refused")

	gone, err := store.GetNode(ctx, own.ID)
	assert.True(t, err != nil || gone == nil, "the row is gone for good")
	left, err := filepath.Glob(filepath.Join(root, trash.Prefix, "*__notlar.md"))
	require.NoError(t, err)
	assert.Empty(t, left, "and the bytes in the trash went with it")

	// The refusal has to stay a refusal: nothing of anybody else's moved.
	stranger, err := store.GetNode(ctx, firstForeign)
	require.NoError(t, err)
	require.NotNil(t, stranger)
	assert.NotNil(t, stranger.DeletedAt, "a stranger's entry is still exactly where it was")
	rest, _, err := svc.List(ctx, nil, true, db.NodeFacets{}, otherPeople, 0)
	require.NoError(t, err)
	assert.Len(t, rest, otherPeople, "and all of them are still in the trash")
}
