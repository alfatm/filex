package handlers_test

// Integration tests for user groups and group grants (migration 00043),
// exercised through the real router: admin CRUD, the permissions panel, the
// drive list and shared-with-me.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// createGroup makes a group via the admin API and returns its id.
func createGroup(t *testing.T, url string, admin *http.Client, name string) int64 {
	t.Helper()
	st, raw := doReq(t, admin, http.MethodPost, url+"/api/admin/groups", map[string]any{"name": name})
	require.Equal(t, http.StatusCreated, st, "create group %s: %s", name, raw)
	var g struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(raw, &g))
	require.NotZero(t, g.ID)
	return g.ID
}

// groupsFixture spins up a server with an RBAC storage, one group, one member
// and one non-member.
type groupsFixture struct {
	url         string
	admin       *http.Client
	groupID     int64
	memberID    int64
	nonMemberID int64
	member      *http.Client
	nonMember   *http.Client
}

func newGroupsFixture(t *testing.T) groupsFixture {
	t.Helper()
	srv, adminClient, store := testutil.NewTestServer(t)
	email, pw := testutil.SeedAdmin(t, store)
	testutil.LoginAs(t, srv, adminClient, email, pw)

	st, raw := doReq(t, adminClient, http.MethodPost, srv.URL+"/api/admin/storages", model.Storage{
		Name:          "gs1",
		Driver:        "local",
		MountPath:     "/data",
		ConfigJSON:    json.RawMessage(fmt.Sprintf(`{"root":%q}`, t.TempDir())),
		SyncMode:      model.SyncModePoll,
		SyncIntervalS: 900,
		Enabled:       true,
		RBACEnabled:   true,
	})
	require.Equal(t, http.StatusOK, st, "create storage: %s", raw)

	f := groupsFixture{url: srv.URL, admin: adminClient}
	f.groupID = createGroup(t, srv.URL, adminClient, "Design")
	f.memberID = createUser(t, srv.URL, adminClient, "member@test.local", "MemberPass1!", model.RoleUser)
	f.nonMemberID = createUser(t, srv.URL, adminClient, "outsider@test.local", "OutPass1!", model.RoleUser)

	st, raw = doReq(t, adminClient, http.MethodPut,
		fmt.Sprintf("%s/api/admin/groups/%d/members", srv.URL, f.groupID),
		map[string]any{"user_ids": []int64{f.memberID}})
	require.Equal(t, http.StatusOK, st, "replace members: %s", raw)

	f.member = freshClient(t)
	testutil.LoginAs(t, srv, f.member, "member@test.local", "MemberPass1!")
	f.nonMember = freshClient(t)
	testutil.LoginAs(t, srv, f.nonMember, "outsider@test.local", "OutPass1!")
	return f
}

func TestAdminGroups_CRUDAndMembers(t *testing.T) {
	f := newGroupsFixture(t)

	// A second group with the same name is refused.
	st, _ := doReq(t, f.admin, http.MethodPost, f.url+"/api/admin/groups", map[string]any{"name": "Design"})
	assert.Equal(t, http.StatusConflict, st, "duplicate group name")

	st, raw := doReq(t, f.admin, http.MethodGet, f.url+"/api/admin/groups?q=des", nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var list struct {
		Groups []map[string]any `json:"groups"`
		Total  int              `json:"total"`
	}
	require.NoError(t, json.Unmarshal(raw, &list))
	require.Len(t, list.Groups, 1)
	assert.Equal(t, 1, list.Total)
	assert.EqualValues(t, 1, list.Groups[0]["member_count"])

	// Detail carries the members.
	st, raw = doReq(t, f.admin, http.MethodGet, fmt.Sprintf("%s/api/admin/groups/%d", f.url, f.groupID), nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var detail struct {
		Name    string           `json:"name"`
		Members []map[string]any `json:"members"`
	}
	require.NoError(t, json.Unmarshal(raw, &detail))
	assert.Equal(t, "Design", detail.Name)
	require.Len(t, detail.Members, 1)
	assert.Equal(t, "member@test.local", detail.Members[0]["email"])

	// Rename + description.
	st, raw = doReq(t, f.admin, http.MethodPatch, fmt.Sprintf("%s/api/admin/groups/%d", f.url, f.groupID),
		map[string]any{"name": "Design Team", "description": "the design people"})
	require.Equal(t, http.StatusOK, st, "%s", raw)

	// Add + remove one member through the singular routes.
	st, _ = doReq(t, f.admin, http.MethodPost, fmt.Sprintf("%s/api/admin/groups/%d/members", f.url, f.groupID),
		map[string]any{"user_id": f.nonMemberID})
	require.Equal(t, http.StatusOK, st)
	st, _ = doReq(t, f.admin, http.MethodDelete,
		fmt.Sprintf("%s/api/admin/groups/%d/members/%d", f.url, f.groupID, f.nonMemberID), nil)
	require.Equal(t, http.StatusOK, st)

	// An unknown account cannot be made a member.
	st, _ = doReq(t, f.admin, http.MethodPost, fmt.Sprintf("%s/api/admin/groups/%d/members", f.url, f.groupID),
		map[string]any{"user_id": 999999})
	assert.Equal(t, http.StatusBadRequest, st, "unknown user_id")

	st, _ = doReq(t, f.admin, http.MethodDelete, fmt.Sprintf("%s/api/admin/groups/%d", f.url, f.groupID), nil)
	require.Equal(t, http.StatusOK, st)
	st, _ = doReq(t, f.admin, http.MethodGet, fmt.Sprintf("%s/api/admin/groups/%d", f.url, f.groupID), nil)
	assert.Equal(t, http.StatusNotFound, st, "a deleted group is gone")
}

func TestGroupGrant_MemberSeesStorage_NonMemberDoesNot(t *testing.T) {
	f := newGroupsFixture(t)

	st, raw := doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions",
		map[string]any{"path": "gs1://team", "group_id": f.groupID, "level": "editor"})
	require.Equal(t, http.StatusOK, st, "grant to group: %s", raw)

	type driveList struct {
		Storages []struct {
			Name      string   `json:"name"`
			Shared    bool     `json:"shared"`
			ViaGroups []string `json:"via_groups"`
		} `json:"storages"`
	}
	st, raw = doReq(t, f.member, http.MethodGet, f.url+"/api/files/storages", nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var mine driveList
	require.NoError(t, json.Unmarshal(raw, &mine))
	require.Len(t, mine.Storages, 1, "the member sees the drive the group was granted")
	assert.True(t, mine.Storages[0].Shared)
	assert.Equal(t, []string{"Design"}, mine.Storages[0].ViaGroups)

	st, raw = doReq(t, f.nonMember, http.MethodGet, f.url+"/api/files/storages", nil)
	require.Equal(t, http.StatusOK, st)
	var theirs driveList
	require.NoError(t, json.Unmarshal(raw, &theirs))
	assert.Empty(t, theirs.Storages, "a non-member sees nothing")

	// The member may read the panel on the granted path; the outsider may not.
	st, _ = doReq(t, f.member, http.MethodGet, f.url+"/api/files/permissions?path=gs1://team", nil)
	assert.Equal(t, http.StatusOK, st)
	st, _ = doReq(t, f.nonMember, http.MethodGet, f.url+"/api/files/permissions?path=gs1://team", nil)
	assert.Equal(t, http.StatusForbidden, st)
}

func TestPermissionsPanel_GroupRowAndPrincipal(t *testing.T) {
	f := newGroupsFixture(t)
	st, raw := doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions",
		map[string]any{"path": "gs1://team", "group_id": f.groupID, "level": "editor"})
	require.Equal(t, http.StatusOK, st, "%s", raw)
	st, raw = doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions",
		map[string]any{"path": "gs1://team", "user_id": f.nonMemberID, "level": "viewer", "is_dir": false})
	require.Equal(t, http.StatusOK, st, "%s", raw)

	st, raw = doReq(t, f.admin, http.MethodGet, f.url+"/api/files/permissions?path=gs1://team", nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var panel struct {
		Direct []map[string]any `json:"direct"`
	}
	require.NoError(t, json.Unmarshal(raw, &panel))
	require.Len(t, panel.Direct, 2)

	var groupRow, userRow map[string]any
	for _, row := range panel.Direct {
		switch row["principal"] {
		case model.PrincipalGroup:
			groupRow = row
		case model.PrincipalUser:
			userRow = row
		}
	}
	require.NotNil(t, groupRow, "a group row with principal=group")
	require.NotNil(t, userRow, "a user row with principal=user")
	assert.Equal(t, "Design", groupRow["group_name"])
	assert.EqualValues(t, f.groupID, groupRow["group_id"])
	assert.EqualValues(t, 1, groupRow["member_count"])
	assert.NotContains(t, groupRow, "user_email", "a group row names no account")
	// is_dir is honoured from the body for both principals.
	assert.Equal(t, true, groupRow["is_dir"])
	assert.Equal(t, false, userRow["is_dir"])

	// The picker lists the group for a non-viewer caller.
	st, raw = doReq(t, f.member, http.MethodGet, f.url+"/api/files/permissions/groups?q=des", nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var picker struct {
		Groups []map[string]any `json:"groups"`
	}
	require.NoError(t, json.Unmarshal(raw, &picker))
	require.Len(t, picker.Groups, 1)
	assert.Equal(t, "Design", picker.Groups[0]["name"])
}

func TestGroupGrant_PatchAndDeleteWithPrincipalQuery(t *testing.T) {
	f := newGroupsFixture(t)
	st, raw := doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions",
		map[string]any{"path": "gs1://team", "group_id": f.groupID, "level": "viewer"})
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var created struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(raw, &created))

	// Without ?principal= the id addresses file_grants, where it does not exist.
	st, _ = doReq(t, f.admin, http.MethodPatch,
		fmt.Sprintf("%s/api/files/permissions/%d", f.url, created.ID), map[string]any{"level": "editor"})
	assert.Equal(t, http.StatusNotFound, st, "a group id must not resolve as a user grant")

	st, raw = doReq(t, f.admin, http.MethodPatch,
		fmt.Sprintf("%s/api/files/permissions/%d?principal=group", f.url, created.ID), map[string]any{"level": "editor"})
	require.Equal(t, http.StatusOK, st, "%s", raw)

	st, raw = doReq(t, f.admin, http.MethodGet, f.url+"/api/files/permissions?path=gs1://team", nil)
	require.Equal(t, http.StatusOK, st)
	var panel struct {
		Direct []map[string]any `json:"direct"`
	}
	require.NoError(t, json.Unmarshal(raw, &panel))
	require.Len(t, panel.Direct, 1)
	assert.Equal(t, "editor", panel.Direct[0]["level"])

	st, _ = doReq(t, f.admin, http.MethodDelete,
		fmt.Sprintf("%s/api/files/permissions/%d?principal=group", f.url, created.ID), nil)
	require.Equal(t, http.StatusOK, st)
	st, raw = doReq(t, f.admin, http.MethodGet, f.url+"/api/files/permissions?path=gs1://team", nil)
	require.Equal(t, http.StatusOK, st)
	require.NoError(t, json.Unmarshal(raw, &panel))
	assert.Empty(t, panel.Direct, "the group grant is gone")
}

func TestInvite_GroupAndUnknownEmailNote(t *testing.T) {
	f := newGroupsFixture(t)

	st, raw := doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions/invite",
		map[string]any{"path": "gs1://team", "group_id": f.groupID, "level": "editor"})
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var inv map[string]any
	require.NoError(t, json.Unmarshal(raw, &inv))
	assert.Equal(t, "granted", inv["mode"])
	assert.Equal(t, "Design", inv["group_name"])

	// An unknown group is a 404, not a silent share link.
	st, _ = doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions/invite",
		map[string]any{"path": "gs1://team", "group_id": 999999, "level": "editor"})
	assert.Equal(t, http.StatusNotFound, st)

	// Inviting an existing account still reports mode=granted.
	st, raw = doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions/invite",
		map[string]any{"path": "gs1://team", "email": "outsider@test.local", "level": "viewer"})
	require.Equal(t, http.StatusOK, st, "%s", raw)
	require.NoError(t, json.Unmarshal(raw, &inv))
	assert.Equal(t, "granted", inv["mode"])
}

func TestAdminGrants_CreatePatchAndGroupRows(t *testing.T) {
	f := newGroupsFixture(t)
	// Find the storage id the admin grants API addresses.
	st, raw := doReq(t, f.admin, http.MethodGet, f.url+"/api/admin/storages", nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var storages []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	require.NoError(t, json.Unmarshal(raw, &storages))
	var storageID int64
	for _, s := range storages {
		if s.Name == "gs1" {
			storageID = s.ID
		}
	}
	require.NotZero(t, storageID)

	st, raw = doReq(t, f.admin, http.MethodPost, f.url+"/api/admin/grants", map[string]any{
		"storage_id": storageID, "path": "team", "is_dir": true, "level": "editor", "group_id": f.groupID,
	})
	require.Equal(t, http.StatusCreated, st, "%s", raw)
	var g struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(raw, &g))

	// The same pair again is a conflict, not a silent relevel.
	st, _ = doReq(t, f.admin, http.MethodPost, f.url+"/api/admin/grants", map[string]any{
		"storage_id": storageID, "path": "team", "level": "viewer", "group_id": f.groupID,
	})
	assert.Equal(t, http.StatusConflict, st)

	st, _ = doReq(t, f.admin, http.MethodPatch,
		fmt.Sprintf("%s/api/admin/grants/%d?principal=group", f.url, g.ID), map[string]any{"level": "owner"})
	require.Equal(t, http.StatusOK, st)

	st, raw = doReq(t, f.admin, http.MethodGet, f.url+"/api/admin/grants", nil)
	require.Equal(t, http.StatusOK, st)
	var overview struct {
		Grants []map[string]any `json:"grants"`
	}
	require.NoError(t, json.Unmarshal(raw, &overview))
	var found map[string]any
	for _, row := range overview.Grants {
		if row["principal"] == model.PrincipalGroup {
			found = row
		}
	}
	require.NotNil(t, found, "the overview lists group grants")
	assert.Equal(t, "Design", found["group_name"])
	assert.Equal(t, "owner", found["level"])

	st, _ = doReq(t, f.admin, http.MethodDelete,
		fmt.Sprintf("%s/api/admin/grants/%d?principal=group", f.url, g.ID), nil)
	require.Equal(t, http.StatusOK, st)
}

func TestSharedWithMe_GroupGrantedRowCarriesViaGroup(t *testing.T) {
	f := newGroupsFixture(t)
	st, raw := doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions",
		map[string]any{"path": "gs1://team", "group_id": f.groupID, "level": "editor"})
	require.Equal(t, http.StatusOK, st, "%s", raw)

	st, raw = doReq(t, f.member, http.MethodGet, f.url+"/api/files/manager/shared-with-me", nil)
	require.Equal(t, http.StatusOK, st, "%s", raw)
	var shared struct {
		Files []map[string]any `json:"files"`
		Total int              `json:"total"`
	}
	require.NoError(t, json.Unmarshal(raw, &shared))
	require.Equal(t, 1, shared.Total)
	assert.Equal(t, "Design", shared.Files[0]["via_group"])
	assert.Equal(t, "editor", shared.Files[0]["perm"])

	// A personal grant at the same path, at a HIGHER level, replaces the row
	// rather than adding a second card for the same folder.
	st, raw = doReq(t, f.admin, http.MethodPost, f.url+"/api/files/permissions",
		map[string]any{"path": "gs1://team", "user_id": f.memberID, "level": "owner"})
	require.Equal(t, http.StatusOK, st, "%s", raw)
	st, raw = doReq(t, f.member, http.MethodGet, f.url+"/api/files/manager/shared-with-me", nil)
	require.Equal(t, http.StatusOK, st)
	// A fresh value: unmarshalling into the previous one would MERGE the maps
	// and the assertion below would read the earlier response's via_group.
	var merged struct {
		Files []map[string]any `json:"files"`
		Total int              `json:"total"`
	}
	require.NoError(t, json.Unmarshal(raw, &merged))
	require.Equal(t, 1, merged.Total, "one row per item, not one per grant")
	assert.Equal(t, "owner", merged.Files[0]["perm"], "the higher level wins")
	assert.NotContains(t, merged.Files[0], "via_group")
}
