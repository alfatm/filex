package handlers_test

// Per-role OPERATION permissions, end to end through the real router
// (internal/perm, migration 00044).
//
// Every case here takes ONE operation away from the `user` role and then
// checks two things, never one: that the gated route now answers 403
// ROLE_FORBIDDEN, and that a neighbouring route which uses a DIFFERENT
// operation still does not. A gate that refuses everything passes the first
// assertion just as well as a correct one does.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/perm"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

const rolePermPassword = "correct-horse-battery"

// setRolePerms rewrites one role's allow-list straight in the store, which is
// what an admin PUT ends up doing. Going through the store keeps these tests
// about ENFORCEMENT; the admin endpoint has its own cases below.
func setRolePerms(t *testing.T, store db.Store, role string, ops []string) {
	t.Helper()
	require.NoError(t, store.SetRolePermissions(t.Context(), role, ops))
}

// withoutOps returns the role's defaults minus the named operations.
func withoutOps(role string, drop ...string) []string {
	gone := map[string]bool{}
	for _, d := range drop {
		gone[d] = true
	}
	out := []string{}
	for _, op := range perm.Defaults[role] {
		if !gone[op] {
			out = append(out, op)
		}
	}
	return out
}

// loginRole seeds an account with `role`, logs it in on the client's jar and
// returns the store row.
func loginRole(t *testing.T, srv *httptest.Server, client *http.Client, store db.Store, email, role string) *model.User {
	t.Helper()
	u := testutil.SeedUser(t, store, email, rolePermPassword)
	if role != model.RoleUser {
		require.NoError(t, store.UpdateUserRole(t.Context(), u.ID, role))
		u.Role = role
	}
	testutil.LoginAs(t, srv, client, email, rolePermPassword)
	return u
}

// seedStorage gives the manager routes an adapter to resolve, so a request can
// actually reach the verb dispatch rather than stopping at "no storages".
func rolePermStorage(t *testing.T, store db.Store, name string) *model.Storage {
	t.Helper()
	st, err := store.CreateStorage(t.Context(), &model.Storage{
		Name: name, Driver: "local", MountPath: "/" + name, Enabled: true,
		ConfigJSON: json.RawMessage(`{"root":"` + testutil.TmpFilePath(t, "root") + `"}`),
	})
	require.NoError(t, err)
	return st
}

// roleForbidden asserts the response is the role gate refusing `op`.
func roleForbidden(t *testing.T, resp *http.Response, op string) {
	t.Helper()
	var body map[string]string
	testutil.ReadJSON(t, resp, &body)
	require.Equalf(t, http.StatusForbidden, resp.StatusCode, "body: %v", body)
	assert.Equal(t, "ROLE_FORBIDDEN", body["code"])
	assert.Equal(t, op, body["op"])
	assert.NotEmpty(t, body["error"])
}

// notRoleForbidden asserts the request was NOT stopped by the role gate. It
// deliberately does not demand 200: the test harness has no working driver, so
// a route that gets past the gate may still fail further in — what matters is
// that it failed for some other reason.
func notRoleForbidden(t *testing.T, resp *http.Response) {
	t.Helper()
	if resp.StatusCode != http.StatusForbidden {
		return
	}
	var body map[string]string
	testutil.ReadJSON(t, resp, &body)
	assert.NotEqual(t, "ROLE_FORBIDDEN", body["code"], "route was refused by the role gate")
}

func rolePermPost(t *testing.T, client *http.Client, url string, payload any) *http.Response {
	t.Helper()
	raw, _ := json.Marshal(payload)
	resp, err := client.Post(url, "application/json", bytes.NewReader(raw))
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// ---------- files.upload ----------

func TestRolePerms_UploadRemoved_StagedBeginRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u1@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpUpload))

	resp := rolePermPost(t, client, srv.URL+"/api/files/upload/begin",
		map[string]any{"path": "main://", "name": "a.txt", "size": 10})
	roleForbidden(t, resp, perm.OpUpload)

	// Same role, same request shape, a DIFFERENT operation: mkdir is untouched.
	resp = rolePermPost(t, client, srv.URL+"/api/files/manager?action=newfolder",
		map[string]any{"path": "main://", "name": "shiny"})
	notRoleForbidden(t, resp)
}

func TestRolePerms_UploadRemoved_SaveTextRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u2@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpUpload))

	// The editor is an upload surface. If it were not gated, "no uploads" would
	// be one "open in editor" away from untrue.
	resp := rolePermPost(t, client, srv.URL+"/api/files/save-text",
		map[string]any{"path": "main://notes.md", "content": "hi"})
	roleForbidden(t, resp, perm.OpUpload)
}

func TestRolePerms_UploadRemoved_NewFileRefusedButNewFolderAllowed(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u3@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpUpload))

	resp := rolePermPost(t, client, srv.URL+"/api/files/manager?action=newfile",
		map[string]any{"path": "main://", "name": "a.txt"})
	roleForbidden(t, resp, perm.OpUpload)

	resp = rolePermPost(t, client, srv.URL+"/api/files/manager?action=newfolder",
		map[string]any{"path": "main://", "name": "dir"})
	notRoleForbidden(t, resp)
}

// ---------- files.delete / files.purge ----------

func TestRolePerms_DeleteRemoved_TrashRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u4@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpDelete))

	resp := rolePermPost(t, client, srv.URL+"/api/files/manager?action=delete",
		map[string]any{"path": "main://", "items": []any{map[string]string{"path": "main://a.txt"}}})
	roleForbidden(t, resp, perm.OpDelete)

	// The async per-verb endpoint is the second door onto the same act.
	resp = rolePermPost(t, client, srv.URL+"/api/files/delete",
		map[string]any{"source": []string{"main://a.txt"}})
	roleForbidden(t, resp, perm.OpDelete)

	// Purge is a SEPARATE operation and is still allowed.
	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/files/manager/trash/1", nil)
	require.NoError(t, err)
	purgeResp, err := client.Do(req)
	require.NoError(t, err)
	defer purgeResp.Body.Close()
	notRoleForbidden(t, purgeResp)
}

func TestRolePerms_PurgeRemoved_EmptyTrashRefusedButDeleteAllowed(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u5@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpPurge))

	resp := rolePermPost(t, client, srv.URL+"/api/files/manager/trash/empty", map[string]any{})
	roleForbidden(t, resp, perm.OpPurge)

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/files/manager/trash/1", nil)
	require.NoError(t, err)
	one, err := client.Do(req)
	require.NoError(t, err)
	defer one.Body.Close()
	roleForbidden(t, one, perm.OpPurge)

	// Moving something TO the trash is still permitted — the two halves of
	// "delete" are genuinely separate switches.
	resp = rolePermPost(t, client, srv.URL+"/api/files/manager?action=delete",
		map[string]any{"path": "main://", "items": []any{map[string]string{"path": "main://a.txt"}}})
	notRoleForbidden(t, resp)
}

// ---------- files.restore ----------

func TestRolePerms_RestoreRemoved_TrashAndVersionRestoreRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u6@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpRestore))

	resp := rolePermPost(t, client, srv.URL+"/api/files/manager/restore", map[string]any{"node_id": 1})
	roleForbidden(t, resp, perm.OpRestore)

	resp = rolePermPost(t, client, srv.URL+"/api/files/versions/restore",
		map[string]any{"node_id": 1, "version_id": 1})
	roleForbidden(t, resp, perm.OpRestore)
}

// ---------- files.download ----------

func TestRolePerms_DownloadRemoved_DownloadRefusedButListingAndPreviewAllowed(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u7@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpDownload))

	resp, err := client.Get(srv.URL + "/api/files/manager?q=download&path=main://a.txt")
	require.NoError(t, err)
	defer resp.Body.Close()
	roleForbidden(t, resp, perm.OpDownload)

	// Preview is NOT gated: a role that may read a document in the browser but
	// not take a copy away is the whole point of a separate download switch.
	prev, err := client.Get(srv.URL + "/api/files/manager?q=preview&path=main://a.txt")
	require.NoError(t, err)
	defer prev.Body.Close()
	notRoleForbidden(t, prev)

	// …and neither is listing.
	idx, err := client.Get(srv.URL + "/api/files/manager?q=index&path=main://")
	require.NoError(t, err)
	defer idx.Body.Close()
	notRoleForbidden(t, idx)

	// The zip route is the other way of taking bytes away, so it goes too.
	zip, err := client.Get(srv.URL + "/api/files/download/zip?path=main://a.txt")
	require.NoError(t, err)
	defer zip.Body.Close()
	roleForbidden(t, zip, perm.OpDownload)
}

// ---------- files.share / files.grant ----------

func TestRolePerms_ShareRemoved_LinkRefusedButGrantAllowed(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u8@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpShare))

	resp := rolePermPost(t, client, srv.URL+"/api/files/share", map[string]any{"node_id": 1})
	roleForbidden(t, resp, perm.OpShare)

	resp = rolePermPost(t, client, srv.URL+"/api/files/permissions",
		map[string]any{"path": "main://", "user_id": 1, "level": "viewer"})
	notRoleForbidden(t, resp)
}

func TestRolePerms_GrantRemoved_PermissionsPanelRefused(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u9@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpGrant))

	resp := rolePermPost(t, client, srv.URL+"/api/files/permissions",
		map[string]any{"path": "main://", "user_id": 1, "level": "viewer"})
	roleForbidden(t, resp, perm.OpGrant)

	// Reading who has access is not gated — only changing it is.
	list, err := client.Get(srv.URL + "/api/files/permissions?path=main://")
	require.NoError(t, err)
	defer list.Body.Close()
	notRoleForbidden(t, list)
}

// ---------- files.tags / files.star ----------

func TestRolePerms_TagsRemoved_SetTagsRefusedButStarAllowed(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "u10@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, withoutOps(model.RoleUser, perm.OpTags))

	resp := rolePermPost(t, client, srv.URL+"/api/files/manager/tags",
		map[string]any{"node_id": 1, "tags": []string{"blue"}})
	roleForbidden(t, resp, perm.OpTags)

	resp = rolePermPost(t, client, srv.URL+"/api/files/manager/star",
		map[string]any{"node_id": 1, "starred": true})
	notRoleForbidden(t, resp)
}

// ---------- the viewer role, unchanged ----------

// The defaults must not regress what a viewer could already do. A viewer has
// always been able to download and star; the operation list exists to SHOW
// that, not to alter it.
func TestRolePerms_ViewerDefaultsUnchanged(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	loginRole(t, srv, client, store, "v1@test.local", model.RoleViewer)

	dl, err := client.Get(srv.URL + "/api/files/manager?q=download&path=main://a.txt")
	require.NoError(t, err)
	defer dl.Body.Close()
	notRoleForbidden(t, dl)

	star := rolePermPost(t, client, srv.URL+"/api/files/manager/star",
		map[string]any{"node_id": 1, "starred": true})
	notRoleForbidden(t, star)

	// …and just as certainly cannot upload.
	up := rolePermPost(t, client, srv.URL+"/api/files/upload/begin",
		map[string]any{"path": "main://", "name": "a.txt", "size": 10})
	roleForbidden(t, up, perm.OpUpload)
}

// An admin carries the wildcard and is never stopped, whatever the `user` row
// says.
func TestRolePerms_AdminSkipsTheGate(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	rolePermStorage(t, store, "main")
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)
	setRolePerms(t, store, model.RoleUser, nil)

	resp := rolePermPost(t, client, srv.URL+"/api/files/upload/begin",
		map[string]any{"path": "main://", "name": "a.txt", "size": 10})
	notRoleForbidden(t, resp)
}

// ---------- GET/PUT /api/admin/roles ----------

func TestRolePerms_AdminList_Shape(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)

	resp, err := client.Get(srv.URL + "/api/admin/roles")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got struct {
		Roles []struct {
			Name        string   `json:"name"`
			Permissions []string `json:"permissions"`
			Editable    bool     `json:"editable"`
		} `json:"roles"`
		Catalogue []perm.Op `json:"catalogue"`
	}
	testutil.ReadJSON(t, resp, &got)

	require.Len(t, got.Roles, 3)
	byName := map[string]int{}
	for i, r := range got.Roles {
		byName[r.Name] = i
	}
	admin := got.Roles[byName[model.RoleAdmin]]
	assert.False(t, admin.Editable, "the admin role must not be editable")
	assert.Equal(t, perm.AllOps(), admin.Permissions, "admin is reported expanded, not as \"*\"")

	assert.True(t, got.Roles[byName[model.RoleUser]].Editable)
	assert.Equal(t, perm.Defaults[model.RoleViewer], got.Roles[byName[model.RoleViewer]].Permissions)
	assert.Equal(t, perm.Catalogue, got.Catalogue)
}

func TestRolePerms_AdminPut_WritesAndValidates(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)

	put := func(role string, payload any) *http.Response {
		t.Helper()
		raw, _ := json.Marshal(payload)
		req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/admin/roles/"+role, bytes.NewReader(raw))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}

	// Happy path — and the answer is the stored row, in catalogue order.
	resp := put(model.RoleUser, map[string]any{
		"permissions": []string{perm.OpDownload, perm.OpUpload},
	})
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var row struct {
		Name        string   `json:"name"`
		Permissions []string `json:"permissions"`
		Editable    bool     `json:"editable"`
	}
	testutil.ReadJSON(t, resp, &row)
	assert.Equal(t, model.RoleUser, row.Name)
	assert.True(t, row.Editable)
	assert.Equal(t, []string{perm.OpUpload, perm.OpDownload}, row.Permissions)

	stored, err := store.GetRolePermissions(t.Context(), model.RoleUser)
	require.NoError(t, err)
	assert.Equal(t, []string{perm.OpUpload, perm.OpDownload}, stored)

	assert.Equal(t, http.StatusBadRequest,
		put(model.RoleAdmin, map[string]any{"permissions": []string{perm.OpDownload}}).StatusCode,
		"the admin role must not be editable")
	assert.Equal(t, http.StatusBadRequest,
		put("auditor", map[string]any{"permissions": []string{perm.OpDownload}}).StatusCode,
		"unknown role")
	assert.Equal(t, http.StatusBadRequest,
		put(model.RoleViewer, map[string]any{"permissions": []string{"files.teleport"}}).StatusCode,
		"unknown operation")
}

func TestRolePerms_AdminRoles_RefusesNonAdmin(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	loginRole(t, srv, client, store, "nobody@test.local", model.RoleUser)

	resp, err := client.Get(srv.URL + "/api/admin/roles")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

// ---------- capabilities ----------

func TestRolePerms_CapabilitiesCarryCallerPermissions(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)

	// Anonymous: no role, so an empty list — never the defaults.
	anon := &http.Client{}
	resp, err := anon.Get(srv.URL + "/api/files/capabilities")
	require.NoError(t, err)
	defer resp.Body.Close()
	var got struct {
		Permissions []string `json:"permissions"`
	}
	testutil.ReadJSON(t, resp, &got)
	assert.Empty(t, got.Permissions)

	// A signed-in user sees their own role's set, reflecting a live edit.
	loginRole(t, srv, client, store, "cap@test.local", model.RoleUser)
	setRolePerms(t, store, model.RoleUser, []string{perm.OpDownload, perm.OpStar})
	resp2, err := client.Get(srv.URL + "/api/files/capabilities")
	require.NoError(t, err)
	defer resp2.Body.Close()
	testutil.ReadJSON(t, resp2, &got)
	assert.Equal(t, []string{perm.OpDownload, perm.OpStar}, got.Permissions)
}

func TestRolePerms_CapabilitiesForAdminAreTheWholeCatalogue(t *testing.T) {
	srv, client, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, client, email, pw)

	resp, err := client.Get(srv.URL + "/api/files/capabilities")
	require.NoError(t, err)
	defer resp.Body.Close()
	var got struct {
		Permissions []string `json:"permissions"`
	}
	testutil.ReadJSON(t, resp, &got)
	assert.Equal(t, perm.AllOps(), got.Permissions)
}
