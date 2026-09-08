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

// userStorage is deliberately narrow: a name to address the drive by and
// whether writing to it is pointless. Driver, mount path and configuration are
// operator business and stay on the admin route.
type userStorage struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"read_only"`
	// UsedBytes is what THIS drive holds. The quota endpoint next to it meters
	// the ACCOUNT, so a client drawing a figure per drive from it was repeating
	// one number under every drive and calling each of them that drive's.
	UsedBytes int64 `json:"used_bytes"`
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
		out = append(out, userStorage{Name: s.Name, ReadOnly: s.ReadOnly, UsedBytes: usage[s.ID]})
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
