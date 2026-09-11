// Package handlers — storages_user.go
//
// Endpoint:
//
//	GET /api/files/storages   (auth)  the drives THIS user may open
//
// The admin surface (/api/admin/storages) answers a different question — it
// lists every configured backend with its driver, credentials shape and sync
// state, and it is not reachable by a normal account. An ordinary user needs
// one thing before they can open anything: which drives exist for them, by the
// name that addresses them (`<name>://<path>`).
//
// Until now that answer only came back as a side effect of listing a folder
// (the `storages` field of `?q=index`), which means a client could not draw a
// drive switcher before it had already picked a drive to list. Hence this
// route: same visibility rules, no listing required.
package handlers

import (
	"net/http"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/confine"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
)

// StoragesUser handles the user-facing storage list.
type StoragesUser struct {
	Store db.Store
	// ACL hides RBAC-on storages the caller holds no grant in. nil disables
	// enforcement, exactly as it does on the manager handler.
	ACL *acl.Resolver
}

// NewStoragesUser constructs the handler.
func NewStoragesUser(store db.Store) *StoragesUser { return &StoragesUser{Store: store} }

// AttachACL wires the RBAC resolver.
func (h *StoragesUser) AttachACL(r *acl.Resolver) { h.ACL = r }

// userStorage is deliberately narrow: what addresses the drive, and whether
// writing to it is pointless. Driver, mount path and configuration are operator
// business and stay on the admin route.
type userStorage struct {
	// ID is the drive's row id. The NAME is what addresses a drive everywhere
	// in this API (`<name>://<path>`), and this is not a second way to do that
	// — it is for the one endpoint that has never taken a name: /api/files/search
	// narrows to a drive by `storage_id` and by nothing else, so a client that
	// only knew names could not offer "search this drive" at all. It sieved the
	// answer by name instead, which quietly turns `limit` into a lie: a hundred
	// hits from another drive come back as an empty page.
	//
	// It is not a secret. It identifies a row the caller can already see by
	// name, on a list already filtered to what they may open, and every
	// endpoint that takes it re-checks the caller's grants anyway.
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	ReadOnly bool   `json:"read_only"`
	// UsedBytes is what THIS drive holds. The quota endpoint next to it meters
	// the ACCOUNT, so a client drawing a figure per drive from it was repeating
	// one number under every drive and calling each of them that drive's.
	UsedBytes int64 `json:"used_bytes"`
	// Shared reports that the caller reaches this drive through GRANTS rather
	// than through their account role — a shared drive, in the sense
	// `shared-with-me` already uses the word.
	//
	// It exists so the Owner column can say something true on such a drive. A
	// person browsing a team drive does not care which colleague happened to
	// upload each file; what they need to know is that the drive is not theirs.
	// So the column names the drive there, and names people only where naming a
	// person means something.
	//
	// The test is the one `shared-with-me` makes: grants are loaded only for a
	// non-admin on an RBAC-enabled storage, so holding any is exactly the
	// condition. An admin reaches everything by role and no drive is "shared
	// with" them; on an RBAC-off drive a grant is inert and the files are just
	// the account's own.
	Shared bool `json:"shared,omitempty"`
	// ViaGroups names the groups through which the caller holds any grant on
	// this drive (migration 00043). `shared` says access is not by role;
	// this says whose access it actually is, which is the difference between
	// "somebody gave this to me" and "I can see it because I am on the team".
	// Always an array, empty when access is entirely personal.
	ViaGroups []string `json:"via_groups"`
}

// List returns the enabled storages the caller can see, in store order.
//
// Visibility repeats the rule listVuefinder applies to the same list: an
// RBAC-off storage is visible to every authenticated account, an RBAC-on one
// only to a caller holding at least one grant inside it.
//
// A root-confined caller sees ONLY the drive its root names. Confinement is
// enforced per path everywhere else, but this endpoint carries no path for the
// middleware to rewrite — an unfiltered answer would hand a confined tenant the
// names of every other drive on the installation.
func (h *StoragesUser) List(w http.ResponseWriter, r *http.Request) {
	storages, err := h.Store.ListEnabledStorages(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	root, confined := confine.RootFrom(r.Context())
	visible := make([]*model.Storage, 0, len(storages))
	shared := make(map[int64]bool, len(storages))
	viaGroups := make(map[int64][]string, len(storages))
	user := auth.UserFrom(r.Context())
	for _, s := range storages {
		if confined && root.Adapter != "" && root.Adapter != s.Name {
			continue
		}
		if h.ACL != nil {
			set, aerr := h.ACL.LoadSet(r.Context(), user, s)
			if aerr != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": aerr.Error()})
				return
			}
			if !set.StorageVisible() {
				continue
			}
			shared[s.ID] = len(set.Grants()) > 0
			viaGroups[s.ID] = set.ViaGroups()
		}
		visible = append(visible, s)
	}
	usage, err := h.Store.StorageUsage(r.Context(), storageIDs(visible))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]userStorage, 0, len(visible))
	for _, s := range visible {
		via := viaGroups[s.ID]
		if via == nil {
			via = []string{}
		}
		out = append(out, userStorage{
			ID: s.ID, Name: s.Name, ReadOnly: s.ReadOnly, UsedBytes: usage[s.ID], Shared: shared[s.ID], ViaGroups: via,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"storages": out})
}

// storageIDs is the id list for the usage query.
func storageIDs(storages []*model.Storage) []int64 {
	ids := make([]int64, len(storages))
	for i, s := range storages {
		ids[i] = s.ID
	}
	return ids
}
