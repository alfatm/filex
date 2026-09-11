// Package postgres — groups.go
//
// User groups, group membership and group-addressed file grants (migration
// 00043). The SQLite/MySQL twin lives in drivers/sqlite/groups.go; keep the two
// in step. "groups" is a non-reserved keyword here and needs no quoting.
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/brf-tech/filex/backend/internal/model"
)

const groupCols = `g.id, g.name, g.description, g.provider_id, g.created_by, g.created_at, g.updated_at, ` +
	`(SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id)`

func scanGroup(r rowScanner) (*model.Group, error) {
	g := &model.Group{}
	var providerID, createdBy sql.NullInt64
	if err := r.Scan(&g.ID, &g.Name, &g.Description, &providerID, &createdBy, &g.CreatedAt, &g.UpdatedAt, &g.MemberCount); err != nil {
		return nil, err
	}
	if providerID.Valid {
		v := providerID.Int64
		g.ProviderID = &v
	}
	if createdBy.Valid {
		v := createdBy.Int64
		g.CreatedBy = &v
	}
	return g, nil
}

func (s *Store) CreateGroup(ctx context.Context, g *model.Group) (*model.Group, error) {
	var id int64
	if err := s.db.QueryRowContext(ctx,
		`INSERT INTO groups (name, description, provider_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
		g.Name, g.Description, g.ProviderID, g.CreatedBy).Scan(&id); err != nil {
		return nil, err
	}
	return s.GetGroup(ctx, id)
}

func (s *Store) GetGroup(ctx context.Context, id int64) (*model.Group, error) {
	return scanGroup(s.db.QueryRowContext(ctx, `SELECT `+groupCols+` FROM groups g WHERE g.id=$1`, id))
}

func (s *Store) UpdateGroup(ctx context.Context, id int64, name, description string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE groups SET name=$1, description=$2, updated_at=NOW() WHERE id=$3`, name, description, id)
	return err
}

// DeleteGroup relies on ON DELETE CASCADE for members and grants, but clears
// both explicitly so the behaviour matches the SQLite driver exactly.
func (s *Store) DeleteGroup(ctx context.Context, id int64) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM file_group_grants WHERE group_id=$1`, id); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id=$1`, id); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM groups WHERE id=$1`, id)
	return err
}

func groupFilter(q string, providerID *int64) (string, []any) {
	where := ` WHERE TRUE`
	var args []any
	if providerID != nil {
		args = append(args, *providerID)
		where += ` AND g.provider_id=$` + strconv.Itoa(len(args))
	}
	if q = strings.TrimSpace(q); q != "" {
		args = append(args, "%"+strings.ToLower(q)+"%")
		where += ` AND LOWER(g.name) LIKE $` + strconv.Itoa(len(args))
	}
	return where, args
}

func (s *Store) ListGroups(ctx context.Context, q string, providerID *int64, limit, offset int) ([]*model.Group, int, error) {
	where, args := groupFilter(q, providerID)
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM groups g`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		fmt.Sprintf(`SELECT %s FROM groups g%s ORDER BY g.name LIMIT $%d OFFSET $%d`, groupCols, where, len(args)+1, len(args)+2),
		append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []*model.Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, g)
	}
	return out, total, rows.Err()
}

func (s *Store) SearchGroups(ctx context.Context, q string, providerID *int64, limit int) ([]*model.Group, error) {
	if limit <= 0 {
		limit = 10
	}
	out, _, err := s.ListGroups(ctx, q, providerID, limit, 0)
	return out, err
}

func (s *Store) ListGroupMembers(ctx context.Context, groupID int64) ([]*model.User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+userCols+` FROM users WHERE id IN (SELECT user_id FROM group_members WHERE group_id=$1) ORDER BY id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*model.User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetGroupMembers replaces the membership in one transaction: a half-applied
// replace would silently revoke access the caller meant to keep.
func (s *Store) SetGroupMembers(ctx context.Context, groupID int64, userIDs []int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM group_members WHERE group_id=$1`, groupID); err != nil {
		return err
	}
	for _, uid := range userIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO group_members (group_id, user_id) VALUES ($1,$2)`, groupID, uid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AddGroupMember is idempotent.
func (s *Store) AddGroupMember(ctx context.Context, groupID, userID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, groupID, userID)
	return err
}

func (s *Store) RemoveGroupMember(ctx context.Context, groupID, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`, groupID, userID)
	return err
}

func (s *Store) ListGroupsOfUser(ctx context.Context, userID int64) ([]*model.Group, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+groupCols+` FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=$1 ORDER BY g.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*model.Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// ─────────────────── Group file grants ───────────────────

const fileGroupGrantCols = `id, storage_id, path_prefix, is_dir, group_id, level, created_by, created_at`

func scanFileGroupGrant(r rowScanner) (*model.FileGroupGrant, error) {
	g := &model.FileGroupGrant{}
	var createdBy sql.NullInt64
	if err := r.Scan(&g.ID, &g.StorageID, &g.PathPrefix, &g.IsDir, &g.GroupID, &g.Level, &createdBy, &g.CreatedAt); err != nil {
		return nil, err
	}
	if createdBy.Valid {
		v := createdBy.Int64
		g.CreatedBy = &v
	}
	return g, nil
}

func (s *Store) CreateFileGroupGrant(ctx context.Context, g *model.FileGroupGrant) (*model.FileGroupGrant, error) {
	return scanFileGroupGrant(s.db.QueryRowContext(ctx,
		`INSERT INTO file_group_grants (storage_id, path_prefix, is_dir, group_id, level, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6)
		 ON CONFLICT (storage_id, path_prefix, group_id)
		 DO UPDATE SET level=EXCLUDED.level, is_dir=EXCLUDED.is_dir, created_by=EXCLUDED.created_by
		 RETURNING `+fileGroupGrantCols,
		g.StorageID, g.PathPrefix, g.IsDir, g.GroupID, g.Level, g.CreatedBy))
}

func (s *Store) GetFileGroupGrant(ctx context.Context, id int64) (*model.FileGroupGrant, error) {
	return scanFileGroupGrant(s.db.QueryRowContext(ctx, `SELECT `+fileGroupGrantCols+` FROM file_group_grants WHERE id=$1`, id))
}

func (s *Store) UpdateFileGroupGrantLevel(ctx context.Context, id int64, level string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE file_group_grants SET level=$1 WHERE id=$2`, level, id)
	return err
}

func (s *Store) DeleteFileGroupGrant(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM file_group_grants WHERE id=$1`, id)
	return err
}

func (s *Store) ListFileGroupGrantsByStorageGroups(ctx context.Context, storageID int64, groupIDs []int64) ([]*model.FileGroupGrant, error) {
	if len(groupIDs) == 0 {
		return nil, nil
	}
	args := []any{storageID}
	marks := make([]string, 0, len(groupIDs))
	for _, id := range groupIDs {
		args = append(args, id)
		marks = append(marks, "$"+strconv.Itoa(len(args)))
	}
	return s.queryFileGroupGrants(ctx,
		`SELECT `+fileGroupGrantCols+` FROM file_group_grants WHERE storage_id=$1 AND group_id IN (`+strings.Join(marks, ",")+`)`,
		args...)
}

// ListFileGroupGrantsByPath returns the group grants applying to pathPrefix —
// the exact-path row plus every ancestor-folder row. The ancestor test lives in
// Go so the prefix rule has exactly one definition (see internal/acl).
func (s *Store) ListFileGroupGrantsByPath(ctx context.Context, storageID int64, pathPrefix string) ([]*model.FileGroupGrant, error) {
	all, err := s.queryFileGroupGrants(ctx,
		`SELECT `+fileGroupGrantCols+` FROM file_group_grants WHERE storage_id=$1 ORDER BY path_prefix, group_id`, storageID)
	if err != nil {
		return nil, err
	}
	rel := strings.Trim(pathPrefix, "/")
	out := make([]*model.FileGroupGrant, 0, len(all))
	for _, g := range all {
		gp := strings.Trim(g.PathPrefix, "/")
		if gp == rel || gp == "" || strings.HasPrefix(rel, gp+"/") {
			out = append(out, g)
		}
	}
	return out, nil
}

func (s *Store) ListAllFileGroupGrants(ctx context.Context) ([]*model.FileGroupGrant, error) {
	return s.queryFileGroupGrants(ctx,
		`SELECT `+fileGroupGrantCols+` FROM file_group_grants ORDER BY storage_id, path_prefix, group_id`)
}

func (s *Store) queryFileGroupGrants(ctx context.Context, q string, args ...any) ([]*model.FileGroupGrant, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*model.FileGroupGrant
	for rows.Next() {
		g, err := scanFileGroupGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
