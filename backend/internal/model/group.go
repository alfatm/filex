package model

import "time"

// Principal kinds for an ACL row. A grant names either one account or one
// group; every row the permissions API returns says which, because the two
// live in different tables and therefore share an id space.
const (
	PrincipalUser  = "user"
	PrincipalGroup = "group"
)

// Group is a named set of accounts (migration 00043). Granting a path to a
// group grants it to whoever is in the group at the moment access is checked —
// removing somebody from the group removes their access, with no grant row to
// find and delete.
//
// ProviderID homes the group in a tenant exactly the way users.provider_id
// homes an account; nil means "no tenant" (single-tenant installs).
type Group struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ProviderID  *int64 `json:"provider_id,omitempty"`
	// MemberCount is filled by the listing queries; it is not a column.
	MemberCount int       `json:"member_count"`
	CreatedBy   *int64    `json:"created_by,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// FileGroupGrant is the group twin of FileGrant: the same (storage, path
// prefix, level) triple, addressed to a group instead of an account. It is a
// separate table rather than a nullable FileGrant.UserID because SQLite cannot
// drop a NOT NULL constraint without rebuilding the table.
type FileGroupGrant struct {
	ID         int64     `json:"id"`
	StorageID  int64     `json:"storage_id"`
	PathPrefix string    `json:"path_prefix"`
	IsDir      bool      `json:"is_dir"`
	GroupID    int64     `json:"group_id"`
	Level      string    `json:"level"`
	CreatedBy  *int64    `json:"created_by,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}
