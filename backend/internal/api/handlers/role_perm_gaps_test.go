package handlers_test

// The write and download surfaces the operation gate USED TO MISS.
//
// Each of these was a way to do gated work through an ungated door: extract a
// zip instead of uploading, zip server-side through the AI surface instead of
// through the browser, fetch /api/files/read?download=1 instead of pressing
// Download, or ask the assistant to empty the trash instead of pressing
// "delete forever". The helpers (setRolePerms, withoutOps, loginRole,
// rolePermStorage, roleForbidden, notRoleForbidden) are the ones in
// role_perm_test.go, deliberately: these are the same rule, not a second one.

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
	"github.com/brf-tech/filex/backend/internal/perm"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// ---------- files.upload: the archive surface ----------

// Extracting an archive writes one file per member — the widest write surface
// in the product, and the one a role that may not upload could use anyway.
func TestRolePerms_UploadRemoved_ArchiveExtractAndAddRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "arc1@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpUpload))

	resp := rolePermPost(t, client, srv.URL+"/api/files/archive/extract",
		map[string]any{"path": "main://bundle.zip", "dest_dir": "main://out"})
	roleForbidden(t, resp, perm.OpUpload)

	resp = rolePermPost(t, client, srv.URL+"/api/files/archive/add",
		map[string]any{"path": "main://new.zip", "files": []any{map[string]string{"source": "main://a.txt"}}})
	roleForbidden(t, resp, perm.OpUpload)

	// Reading what is INSIDE an archive is a read and stays open — the gate
	// has to refuse the write, not the whole feature.
	resp = rolePermPost(t, client, srv.URL+"/api/files/archive/list",
		map[string]any{"path": "main://bundle.zip"})
	notRoleForbidden(t, resp)
}

// ---------- files.upload: the AI surface ----------

// An API token acts as its owner, so /api/ai answers to the owner's role. Zip
// and Unzip were the last two write verbs there without a gate.
func TestRolePerms_UploadRemoved_AIZipAndUnzipRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	u := loginRole(t, srv, client, store, "aizip@test.local", model.RoleUser)
	tok := testutil.NewAPIToken(t, store, u.ID, "")
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpUpload))

	api := &http.Client{}
	resp := aiReq(t, api, http.MethodPost, srv.URL+"/api/ai/zip", tok,
		map[string]any{"sources": []string{"main://a.txt"}, "dest": "main://a.zip"})
	defer resp.Body.Close()
	roleForbidden(t, resp, perm.OpUpload)

	unzip := aiReq(t, api, http.MethodPost, srv.URL+"/api/ai/unzip", tok,
		map[string]any{"src": "main://a.zip", "dest": "main://out"})
	defer unzip.Body.Close()
	roleForbidden(t, unzip, perm.OpUpload)

	// A DIFFERENT operation on the same surface is untouched: the gate is not
	// "the token may do nothing".
	del := aiReq(t, api, http.MethodPost, srv.URL+"/api/ai/delete", tok,
		map[string]any{"path": "main://a.txt"})
	defer del.Body.Close()
	notRoleForbidden(t, del)
}

// ---------- files.download: /api/files/read ----------

// The rule the permission's name promises: viewing is not gated, taking a copy
// is. One handler, both halves — `download=1` is the copy.
func TestRolePerms_DownloadRemoved_ReadAttachmentRefusedButInlineAllowed(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	st := rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "rd1@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpDownload))

	dl, err := client.Get(srv.URL + "/api/files/read?id=1&download=1")
	require.NoError(t, err)
	defer dl.Body.Close()
	roleForbidden(t, dl, perm.OpDownload)

	// …and by storage+path, which is the same handler's other address.
	dl2, err := client.Get(srv.URL + "/api/files/read?storage=" +
		strconv.FormatInt(st.ID, 10) + "&path=a.txt&download=1")
	require.NoError(t, err)
	defer dl2.Body.Close()
	roleForbidden(t, dl2, perm.OpDownload)

	// Inline is viewing: it must NOT be refused by the role gate. (It fails
	// further in — this harness has no driver — which is what notRoleForbidden
	// is for.)
	inline, err := client.Get(srv.URL + "/api/files/read?id=1")
	require.NoError(t, err)
	defer inline.Body.Close()
	notRoleForbidden(t, inline)
}

// ---------- the assistant's plan executor ----------

// The assistant is a SECOND DOOR onto gated work: the plan is executed
// server-side after the person presses Approve, so a role that lost
// files.purge could still empty its trash by asking for it in words.
//
// The refusal is the assistant's own — the card comes back with the item
// skipped and the `forbidden` code an ACL denial uses — not a 500, and not a
// silent success.
func TestRolePerms_PurgeRemoved_AssistantEmptyTrashPlanRefused(t *testing.T) {
	provider := newScriptedProvider(t,
		toolFrame("call_1", "plan_empty_trash", map[string]any{"summary": "Empty the trash"}),
		textFrame("Proposed."),
		toolFrame("call_2", "plan_tags", map[string]any{
			"paths": []string{"main://notes/hello.txt"}, "tags": []string{"blue"}, "summary": "Tag it",
		}),
		textFrame("Proposed."),
	)
	srv, client, store := assistantTrashACL(t, provider)
	ctx := context.Background()
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpPurge))

	session := newSession(t, srv, client)
	events := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session+"/turn", "empty my trash")
	card := planCard(t, events)
	planID, _ := card["plan_id"].(string)
	require.NotEmpty(t, planID)

	st, raw := doReq(t, client, http.MethodPost,
		srv.URL+"/api/assistant/sessions/"+session+"/plans/"+planID+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st, "a refused plan is an answer, not a server error: %s", raw)
	var outcome struct {
		Done    int `json:"done"`
		Skipped int `json:"skipped"`
		Failed  int `json:"failed"`
		Items   []struct {
			State string `json:"state"`
			Code  string `json:"code"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(raw, &outcome))
	assert.Zero(t, outcome.Done, "nothing may be destroyed: %s", raw)
	assert.Zero(t, outcome.Failed, "refused, not broken: %s", raw)
	require.Equal(t, 1, outcome.Skipped, "%s", raw)
	assert.Equal(t, "forbidden", outcome.Items[0].Code)

	// The file the plan named is still in the trash, still restorable.
	storages, err := store.ListEnabledStorages(ctx)
	require.NoError(t, err)
	mine, err := store.GetNodeByPathIncludingDeleted(ctx, storages[0].ID,
		pathkey.Hash(storages[0].ID, "notes/pay.csv"))
	require.NoError(t, err)
	require.NotNil(t, mine)
	assert.NotNil(t, mine.DeletedAt, "the purge was refused, so the entry is still there")

	// A plan of a DIFFERENT kind still runs: files.tags was never taken away.
	session2 := newSession(t, srv, client)
	events2 := turnStream(t, client, srv.URL+"/api/assistant/sessions/"+session2+"/turn", "tag the notes file")
	card2 := planCard(t, events2)
	planID2, _ := card2["plan_id"].(string)
	st2, raw2 := doReq(t, client, http.MethodPost,
		srv.URL+"/api/assistant/sessions/"+session2+"/plans/"+planID2+"/approve", map[string]any{})
	require.Equal(t, http.StatusOK, st2, "approve: %s", raw2)
	require.NoError(t, json.Unmarshal(raw2, &outcome))
	assert.Equal(t, 1, outcome.Done, "a gate that refuses every plan is not a gate: %s", raw2)
}
