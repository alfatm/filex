package acl_test

// Group grants (migration 00043) resolved through the real store: LoadSet must
// merge the caller's own grants with the ones their groups hold, and membership
// must be what decides — not a copy of it taken when the group was granted.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

// groupFixture seeds an RBAC storage, one account, and one group holding it.
func groupFixture(t *testing.T, role string) (db.Store, *model.User, *model.Storage, *model.Group) {
	t.Helper()
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()

	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "g1", Driver: "local", MountPath: "/data",
		ConfigJSON: json.RawMessage(`{"root":"/tmp/filex-acl-group"}`),
		Enabled:    true, RBACEnabled: true,
	})
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	u, err := store.CreateUser(ctx, "member@test.local", "x", role, "en", "UTC")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	grp, err := store.CreateGroup(ctx, &model.Group{Name: "Design"})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	if err := store.AddGroupMember(ctx, grp.ID, u.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}
	return store, u, st, grp
}

func TestLoadSet_GroupGrantGivesAccess(t *testing.T) {
	store, u, st, grp := groupFixture(t, model.RoleUser)
	ctx := context.Background()
	if _, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
		StorageID: st.ID, PathPrefix: "team", IsDir: true, GroupID: grp.ID, Level: model.GrantEditor,
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	set, err := acl.New(store).LoadSet(ctx, u, st)
	if err != nil {
		t.Fatalf("LoadSet: %v", err)
	}
	if got := set.Effective("team/spec.md"); got != acl.LevelEditor {
		t.Errorf("effective inside group grant = %v, want editor", got)
	}
	if !set.StorageVisible() {
		t.Error("a group grant should make the storage visible")
	}
	if got := set.ViaGroups(); len(got) != 1 || got[0] != "Design" {
		t.Errorf("ViaGroups = %v, want [Design]", got)
	}
	if got := set.Effective("elsewhere"); got != acl.LevelNone {
		t.Errorf("effective outside the grant = %v, want none", got)
	}
}

func TestLoadSet_UserAndGroupGrantTakeTheHigher(t *testing.T) {
	store, u, st, grp := groupFixture(t, model.RoleUser)
	ctx := context.Background()
	if _, err := store.CreateFileGrant(ctx, &model.FileGrant{
		StorageID: st.ID, PathPrefix: "team", IsDir: true, UserID: u.ID, Level: model.GrantViewer,
	}); err != nil {
		t.Fatalf("user grant: %v", err)
	}
	if _, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
		StorageID: st.ID, PathPrefix: "team", IsDir: true, GroupID: grp.ID, Level: model.GrantOwner,
	}); err != nil {
		t.Fatalf("group grant: %v", err)
	}

	set, err := acl.New(store).LoadSet(ctx, u, st)
	if err != nil {
		t.Fatalf("LoadSet: %v", err)
	}
	if got := set.Effective("team"); got != acl.LevelOwner {
		t.Errorf("effective = %v, want owner (the higher of the two)", got)
	}
}

func TestLoadSet_GroupGrantStillCappedByRoleCeiling(t *testing.T) {
	store, u, st, grp := groupFixture(t, model.RoleViewer)
	ctx := context.Background()
	if _, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
		StorageID: st.ID, PathPrefix: "team", IsDir: true, GroupID: grp.ID, Level: model.GrantOwner,
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	set, err := acl.New(store).LoadSet(ctx, u, st)
	if err != nil {
		t.Fatalf("LoadSet: %v", err)
	}
	if got := set.Effective("team"); got != acl.LevelViewer {
		t.Errorf("effective = %v, want viewer — the account role caps a group grant too", got)
	}
}

func TestLoadSet_RemovedFromGroupLosesAccess(t *testing.T) {
	store, u, st, grp := groupFixture(t, model.RoleUser)
	ctx := context.Background()
	if _, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
		StorageID: st.ID, PathPrefix: "team", IsDir: true, GroupID: grp.ID, Level: model.GrantEditor,
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if err := store.RemoveGroupMember(ctx, grp.ID, u.ID); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	set, err := acl.New(store).LoadSet(ctx, u, st)
	if err != nil {
		t.Fatalf("LoadSet: %v", err)
	}
	if got := set.Effective("team"); got != acl.LevelNone {
		t.Errorf("effective after leaving the group = %v, want none", got)
	}
	if set.StorageVisible() {
		t.Error("the storage should disappear with the last grant")
	}
}
