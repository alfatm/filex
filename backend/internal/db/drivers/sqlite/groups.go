// Package sqlite — groups.go
//
// User groups, group membership and group-addressed file grants (migration
// 00043). Shared with the MySQL driver, which wraps this Store — hence `?`
// placeholders, no ON CONFLICT, and backticks around `groups` (a reserved word
// in MySQL 8 that SQLite also accepts quoted this way).
package sqlite

import (
	"context"
	"database/sql"
	"strings"

	"github.com/brf-tech/filex/backend/internal/model"
)

// groupCols is the projection every group scan reads, member_count last. The
// count is a correlated subquery rather than a JOIN+GROUP BY so a group with no
// members still comes back (and reads 0) without an OUTER JOIN on every query.
const groupCols = "g.id, g.name, g.description, g.provider_id, g.created_by, g.created_at, g.updated_at, " +
	"(SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id)"

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
	res, err := s.db.ExecContext(ctx,
		"INSERT INTO `groups` (name, description, provider_id, created_by) VALUES (?,?,?,?)",
		g.Name, g.Description, g.ProviderID, g.CreatedBy)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.GetGroup(ctx, id)
}

func (s *Store) GetGroup(ctx context.Context, id int64) (*model.Group, error) {
	return scanGroup(s.db.QueryRowContext(ctx, "SELECT "+groupCols+" FROM `groups` g WHERE g.id=?", id))
}

func (s *Store) UpdateGroup(ctx context.Context, id int64, name, description string) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE `groups` SET name=?, description=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
		name, description, id)
	return err
}

// DeleteGroup removes the group. Membership rows and group grants go with it
// through ON DELETE CASCADE — but SQLite only honours that with foreign keys
// switched on, so both are deleted explicitly first. Cheap, and it keeps the
// behaviour identical on an install whose PRAGMA was never set.
func (s *Store) DeleteGroup(ctx context.Context, id int64) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM file_group_grants WHERE group_id=?`, id); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id=?`, id); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM `groups` WHERE id=?", id)
	return err
}

// groupFilter builds the shared WHERE for the two listing queries.
func groupFilter(q string, providerID *int64) (string, []any) {
	where := " WHERE 1=1"
	var args []any
	if providerID != nil {
		where += " AND g.provider_id=?"
		args = append(args, *providerID)
	}
	if q = strings.TrimSpace(q); q != "" {
		where += " AND LOWER(g.name) LIKE ?"
		args = append(args, "%"+strings.ToLower(q)+"%")
	}
	return where, args
}

func (s *Store) ListGroups(ctx context.Context, q string, providerID *int64, limit, offset int) ([]*model.Group, int, error) {
	where, args := groupFilter(q, providerID)
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `groups` g"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+groupCols+" FROM `groups` g"+where+" ORDER BY g.name LIMIT ? OFFSET ?",
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
		userSelect()+` FROM users WHERE id IN (SELECT user_id FROM group_members WHERE group_id=?) ORDER BY id`, groupID)
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
	if _, err := tx.ExecContext(ctx, `DELETE FROM group_members WHERE group_id=?`, groupID); err != nil {
		return err
	}
	for _, uid := range userIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO group_members (group_id, user_id) VALUES (?,?)`, groupID, uid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AddGroupMember is idempotent — adding somebody twice is not an error the
// caller can act on.
func (s *Store) AddGroupMember(ctx context.Context, groupID, userID int64) error {
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM group_members WHERE group_id=? AND user_id=?`, groupID, userID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO group_members (group_id, user_id) VALUES (?,?)`, groupID, userID)
	return err
}

func (s *Store) RemoveGroupMember(ctx context.Context, groupID, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id=? AND user_id=?`, groupID, userID)
	return err
}

func (s *Store) ListGroupsOfUser(ctx context.Context, userID int64) ([]*model.Group, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT "+groupCols+" FROM `groups` g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.name",
		userID)
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

// CreateFileGroupGrant upserts on (storage_id, path_prefix, group_id) with the
// same portable check-then-write CreateFileGrant uses, for the same reason:
// MySQL wraps this Store and does not understand SQLite's upsert syntax.
func (s *Store) CreateFileGroupGrant(ctx context.Context, g *model.FileGroupGrant) (*model.FileGroupGrant, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE file_group_grants SET level=?, is_dir=?, created_by=? WHERE storage_id=? AND path_prefix=? AND group_id=?`,
		g.Level, btoi(g.IsDir), g.CreatedBy, g.StorageID, g.PathPrefix, g.GroupID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return scanFileGroupGrant(s.db.QueryRowContext(ctx,
			`SELECT `+fileGroupGrantCols+` FROM file_group_grants WHERE storage_id=? AND path_prefix=? AND group_id=?`,
			g.StorageID, g.PathPrefix, g.GroupID))
	}
	ins, err := s.db.ExecContext(ctx,
		`INSERT INTO file_group_grants (storage_id, path_prefix, is_dir, group_id, level, created_by) VALUES (?,?,?,?,?,?)`,
		g.StorageID, g.PathPrefix, btoi(g.IsDir), g.GroupID, g.Level, g.CreatedBy)
	if err != nil {
		return nil, err
	}
	id, _ := ins.LastInsertId()
	return s.GetFileGroupGrant(ctx, id)
}

func (s *Store) GetFileGroupGrant(ctx context.Context, id int64) (*model.FileGroupGrant, error) {
	return scanFileGroupGrant(s.db.QueryRowContext(ctx, `SELECT `+fileGroupGrantCols+` FROM file_group_grants WHERE id=?`, id))
}

func (s *Store) UpdateFileGroupGrantLevel(ctx context.Context, id int64, level string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE file_group_grants SET level=? WHERE id=?`, level, id)
	return err
}

func (s *Store) DeleteFileGroupGrant(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM file_group_grants WHERE id=?`, id)
	return err
}

func (s *Store) ListFileGroupGrantsByStorageGroups(ctx context.Context, storageID int64, groupIDs []int64) ([]*model.FileGroupGrant, error) {
	if len(groupIDs) == 0 {
		return nil, nil
	}
	args := []any{storageID}
	for _, id := range groupIDs {
		args = append(args, id)
	}
	q := `SELECT ` + fileGroupGrantCols + ` FROM file_group_grants WHERE storage_id=? AND group_id IN (` +
		strings.TrimSuffix(strings.Repeat("?,", len(groupIDs)), ",") + `)`
	return s.queryFileGroupGrants(ctx, q, args...)
}

// ListFileGroupGrantsByPath returns the group grants on storageID that apply to
// pathPrefix — the row at that exact path plus every ancestor-folder row that
// cascades onto it. The ancestor test is done here rather than in SQL because
// the prefix rule (see internal/acl) is one definition and SQL LIKE would be a
// second, subtly different one.
func (s *Store) ListFileGroupGrantsByPath(ctx context.Context, storageID int64, pathPrefix string) ([]*model.FileGroupGrant, error) {
	all, err := s.queryFileGroupGrants(ctx,
		`SELECT `+fileGroupGrantCols+` FROM file_group_grants WHERE storage_id=? ORDER BY path_prefix, group_id`, storageID)
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
