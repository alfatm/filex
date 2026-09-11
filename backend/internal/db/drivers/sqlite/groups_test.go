package sqlite_test

// Store-level behaviour of groups (migration 00043): membership replace,
// "which groups is this user in", and what a group delete takes with it.

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/testutil"
)

func seedUsers(t *testing.T, store db.Store, emails ...string) []int64 {
	t.Helper()
	ids := make([]int64, 0, len(emails))
	for _, e := range emails {
		u, err := store.CreateUser(context.Background(), e, "x", model.RoleUser, "en", "UTC")
		if err != nil {
			t.Fatalf("create user %s: %v", e, err)
		}
		ids = append(ids, u.ID)
	}
	return ids
}

func TestSetGroupMembersReplaces(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	ids := seedUsers(t, store, "a@t.local", "b@t.local", "c@t.local")
	grp, err := store.CreateGroup(ctx, &model.Group{Name: "Design"})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}

	if err := store.SetGroupMembers(ctx, grp.ID, ids[:2]); err != nil {
		t.Fatalf("set members: %v", err)
	}
	members, err := store.ListGroupMembers(ctx, grp.ID)
	if err != nil || len(members) != 2 {
		t.Fatalf("ListGroupMembers = %d members, %v; want 2", len(members), err)
	}

	// Replace, not merge: the third account in, the first two out.
	if err := store.SetGroupMembers(ctx, grp.ID, ids[2:]); err != nil {
		t.Fatalf("replace members: %v", err)
	}
	members, err = store.ListGroupMembers(ctx, grp.ID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(members) != 1 || members[0].ID != ids[2] {
		t.Fatalf("after replace got %d members; want only the third account", len(members))
	}

	reread, err := store.GetGroup(ctx, grp.ID)
	if err != nil {
		t.Fatalf("get group: %v", err)
	}
	if reread.MemberCount != 1 {
		t.Errorf("MemberCount = %d, want 1", reread.MemberCount)
	}
}

func TestListGroupsOfUser(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	ids := seedUsers(t, store, "a@t.local", "b@t.local")
	design, _ := store.CreateGroup(ctx, &model.Group{Name: "Design"})
	ops, _ := store.CreateGroup(ctx, &model.Group{Name: "Ops"})
	if err := store.AddGroupMember(ctx, design.ID, ids[0]); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := store.AddGroupMember(ctx, ops.ID, ids[0]); err != nil {
		t.Fatalf("add: %v", err)
	}
	// Adding twice is not an error and does not double the membership.
	if err := store.AddGroupMember(ctx, ops.ID, ids[0]); err != nil {
		t.Fatalf("re-add: %v", err)
	}

	got, err := store.ListGroupsOfUser(ctx, ids[0])
	if err != nil {
		t.Fatalf("ListGroupsOfUser: %v", err)
	}
	if len(got) != 2 || got[0].Name != "Design" || got[1].Name != "Ops" {
		t.Fatalf("got %d groups, want Design+Ops in name order", len(got))
	}
	if other, err := store.ListGroupsOfUser(ctx, ids[1]); err != nil || len(other) != 0 {
		t.Errorf("a non-member should be in no groups, got %d (%v)", len(other), err)
	}
}

func TestDeleteGroupCascadesMembersAndGrants(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	ids := seedUsers(t, store, "a@t.local")
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "s1", Driver: "local", MountPath: "/data",
		ConfigJSON: json.RawMessage(`{"root":"/tmp/filex-group-store"}`),
		Enabled:    true, RBACEnabled: true,
	})
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	grp, _ := store.CreateGroup(ctx, &model.Group{Name: "Design"})
	if err := store.AddGroupMember(ctx, grp.ID, ids[0]); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
		StorageID: st.ID, PathPrefix: "team", IsDir: true, GroupID: grp.ID, Level: model.GrantEditor,
	}); err != nil {
		t.Fatalf("grant: %v", err)
	}

	if err := store.DeleteGroup(ctx, grp.ID); err != nil {
		t.Fatalf("delete group: %v", err)
	}
	if left, err := store.ListGroupsOfUser(ctx, ids[0]); err != nil || len(left) != 0 {
		t.Errorf("membership survived the group: %d (%v)", len(left), err)
	}
	all, err := store.ListAllFileGroupGrants(ctx)
	if err != nil {
		t.Fatalf("list grants: %v", err)
	}
	if len(all) != 0 {
		t.Errorf("%d group grants survived the group they addressed", len(all))
	}
}

func TestListFileGroupGrantsByPathIncludesAncestors(t *testing.T) {
	_, store := testutil.NewTestDB(t)
	ctx := context.Background()
	st, err := store.CreateStorage(ctx, &model.Storage{
		Name: "s1", Driver: "local", MountPath: "/data",
		ConfigJSON: json.RawMessage(`{"root":"/tmp/filex-group-path"}`),
		Enabled:    true, RBACEnabled: true,
	})
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	grp, _ := store.CreateGroup(ctx, &model.Group{Name: "Design"})
	for _, p := range []string{"", "team", "team/sub", "other"} {
		if _, err := store.CreateFileGroupGrant(ctx, &model.FileGroupGrant{
			StorageID: st.ID, PathPrefix: p, IsDir: true, GroupID: grp.ID, Level: model.GrantViewer,
		}); err != nil {
			t.Fatalf("grant %q: %v", p, err)
		}
	}

	got, err := store.ListFileGroupGrantsByPath(ctx, st.ID, "team/sub")
	if err != nil {
		t.Fatalf("by path: %v", err)
	}
	seen := map[string]bool{}
	for _, g := range got {
		seen[g.PathPrefix] = true
	}
	for _, want := range []string{"", "team", "team/sub"} {
		if !seen[want] {
			t.Errorf("prefix %q missing from the applying set", want)
		}
	}
	if seen["other"] {
		t.Error("a sibling folder's grant must not apply")
	}
}
