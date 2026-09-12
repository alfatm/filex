// Package handlers — shared.go
//
// "Shared with me": everything the caller reaches through a per-item grant
// somebody else gave them, rather than through their own role on a storage.
//
//	GET /api/files/manager/shared-with-me?limit=&offset=
//
// It takes the listing filter chips too (see listingFacets), applied before the
// page is cut so `total` counts the filtered set.
//
// The data has always existed in `file_grants`, but nothing could answer this
// question: Grants.List is path-scoped ("who can see THIS folder") and
// owner-only, so a user had no way to find out what had been shared with them
// unless they were told the path. That is the one item on a Drive-style
// navigation panel with no backing endpoint (issue #14).
package handlers

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/auth"
	"github.com/brf-tech/filex/backend/internal/confine"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
	"github.com/brf-tech/filex/backend/internal/pathkey"
)

// Shared serves the shared-with-me listing. Mounted inside the authenticated
// /api/files group, so the session/token middleware and confine.Middleware are
// already in force.
type Shared struct {
	Store db.Store
}

// NewShared constructs the handler.
func NewShared(store db.Store) *Shared { return &Shared{Store: store} }

// SharedWithMe lists the items the caller holds a grant on, newest grant
// first, paginated with ?limit= (default 100, max 500) and ?offset=.
//
// Four decisions worth stating, because each of them is a place where the
// obvious implementation is wrong:
//
//  1. A grant on a FOLDER lists the folder itself, not its contents. That is
//     what the explorer needs: the row is a `dir` whose `path` is
//     adapter-qualified, so opening it navigates into the folder through the
//     ordinary listing endpoint (which applies the same grants again). Listing
//     the contents here would flatten the tree and make the row unopenable.
//
//  2. "Does not own" is expressed the way filex actually models ownership.
//     There is no per-node owner: `nodes.owner_id` exists for quota accounting
//     only and is nil for everything a sync discovered. What separates "shared
//     with me" from "mine" is where the access comes from — on an RBAC-off
//     storage every authenticated user already reaches everything by role, so
//     a grant row there is inert and the items are not "shared", they are just
//     the user's files. Hence: RBAC-enabled storages only.
//
//  3. A grant with an empty path_prefix is a whole-storage grant. It is not
//     listed as an item (its name would be empty); it is what makes the
//     storage appear in `storages` below — the "shared drive" that the panel
//     shows in its storage list rather than as a file row.
//
//  4. Tenancy is filtered explicitly, not assumed. tenantstore wraps exactly
//     three methods, and per-grant reads are not among them, so an unfiltered
//     listing here would hand a tenant the names and paths of another tenant's
//     shared folders — the same cross-tenant leak the search handler filters
//     out at handlers/search.go. Filtering only in ListEnabledStorages would
//     be filtering in a place the test harness does not even wrap.
func (h *Shared) SharedWithMe(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"), 100, 500)
	offset := parseLimit(r.URL.Query().Get("offset"), 0, 1_000_000)
	facets := listingFacets(r)
	// Tags are node_meta rows, and NodeFacets.Matches — the predicate this
	// listing judges its rows with, since they come from grants rather than
	// from one query — cannot read them. Resolving them to the set of nodes
	// that carry every tag makes the chip mean here what it means in the SQL
	// listings; the facet is then cleared, so Matches is not asked a question
	// it has already been answered.
	tagged, err := h.taggedNodes(r.Context(), facets.Tags)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	facets.Tags = nil

	storages, err := h.Store.ListEnabledStorages(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	scope := scopeOf(r.Context())
	root, confined := confine.RootFrom(r.Context())

	type row struct {
		entry map[string]any
		at    int64 // grant created_at, milliseconds — the sort key
		level acl.Level
	}
	var rows []row
	// One row per item, not per grant: the same folder can arrive through a
	// personal grant AND a group the caller is in, and listing it twice would
	// be two identical cards. The higher level wins, matching what acl
	// actually resolves for that path.
	byPath := map[string]int{}
	sharedStorages := []string{}
	// One user lookup per distinct granter rather than per grant: a folder tree
	// somebody shared in one go is many rows from the same person.
	granters := map[int64]string{}

	for _, st := range storages {
		// (4) tenant gate — before any read that could reveal the storage.
		if !scope.CanAccessStorage(st.ID) {
			continue
		}
		// (2) grants are only consulted on RBAC-enabled storages.
		if !st.RBACEnabled {
			continue
		}
		grants, gerr := h.Store.ListFileGrantsByStorageUser(r.Context(), st.ID, u.ID)
		if gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": gerr.Error()})
			return
		}
		// (5) A group the caller is in reaches items just as a personal grant
		// does, and "shared with me" is the only place those items are
		// discoverable. The row says which group, because "why can I see this"
		// has a different answer than for a grant somebody handed the person.
		groupGrants, ggerr := h.groupGrants(r.Context(), st.ID, u.ID)
		if ggerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": ggerr.Error()})
			return
		}
		if len(grants) == 0 && len(groupGrants) == 0 {
			continue
		}
		sharedStorages = append(sharedStorages, st.Name)

		for _, g := range append(append([]*model.FileGrant{}, grants...), groupGrants...) {
			rel := acl.CleanRel(g.PathPrefix)
			if rel == "" {
				continue // (3) whole-storage grant — reported via `storages`
			}
			if confined && !root.Within(st.Name, rel) {
				continue
			}
			key := st.Name + "://" + rel
			level := acl.ParseLevel(g.Level)
			if i, dup := byPath[key]; dup {
				if level <= rows[i].level {
					continue
				}
				entry, node := h.project(r.Context(), st, g, rel, granters)
				if !keepShared(facets, tagged, node, rel, g.IsDir) {
					continue
				}
				rows[i] = row{entry: entry, at: g.CreatedAt.UnixMilli(), level: level}
				continue
			}
			entry, node := h.project(r.Context(), st, g, rel, granters)
			if !keepShared(facets, tagged, node, rel, g.IsDir) {
				continue
			}
			byPath[key] = len(rows)
			rows = append(rows, row{entry: entry, at: g.CreatedAt.UnixMilli(), level: level})
		}
	}

	sort.SliceStable(rows, func(i, j int) bool { return rows[i].at > rows[j].at })

	total := len(rows)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	// A nil slice marshals to `null`, and "nothing has been shared with me" is
	// the normal state for most accounts — exactly when this list is read.
	files := make([]map[string]any, 0, end-offset)
	for _, rw := range rows[offset:end] {
		files = append(files, rw.entry)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"files":    files,
		"storages": sharedStorages,
		"total":    total,
		"limit":    limit,
		"offset":   offset,
	})
}

// groupGrants returns the grants this user reaches on a storage through group
// membership, already projected into the FileGrant shape the row builder takes
// (Principal="group", GroupName set) so both sources walk one loop.
func (h *Shared) groupGrants(ctx context.Context, storageID, userID int64) ([]*model.FileGrant, error) {
	groups, err := h.Store.ListGroupsOfUser(ctx, userID)
	if err != nil || len(groups) == 0 {
		return nil, err
	}
	ids := make([]int64, 0, len(groups))
	name := make(map[int64]string, len(groups))
	for _, g := range groups {
		ids = append(ids, g.ID)
		name[g.ID] = g.Name
	}
	ggs, err := h.Store.ListFileGroupGrantsByStorageGroups(ctx, storageID, ids)
	if err != nil {
		return nil, err
	}
	out := make([]*model.FileGrant, 0, len(ggs))
	for _, gg := range ggs {
		out = append(out, &model.FileGrant{
			ID:         gg.ID,
			StorageID:  gg.StorageID,
			PathPrefix: gg.PathPrefix,
			IsDir:      gg.IsDir,
			Level:      gg.Level,
			CreatedBy:  gg.CreatedBy,
			CreatedAt:  gg.CreatedAt,
			Principal:  model.PrincipalGroup,
			GroupID:    gg.GroupID,
			GroupName:  name[gg.GroupID],
		})
	}
	return out, nil
}

// project turns one grant into the FileNode row the explorer renders.
//
// The indexed node is preferred — it carries size, mime, etag and a thumbnail
// — but a grant can name a path the indexer has never walked, and dropping
// those would make "shared with me" quietly incomplete for exactly the folder
// somebody just shared. So an un-indexed grant becomes a synthetic row built
// from the grant itself: enough to render and to navigate into.
//
// The node row the entry was built from comes back with it — nil for a
// synthetic row — so the caller can test the filter chips against something.
// keepShared decides whether one shared row survives the chips.
//
// A row the indexer has walked is judged like any other node. A row synthesised
// from the grant alone is the case this exists for: it has no size, date or
// owner, so a chip asking for one of those drops it — but its NAME is known, and
// dropping it for a name filter it actually satisfies was a bug people could see.
// Somebody shares a folder, the page shows it, you type its name to find it
// among a hundred others and it disappears, because the indexer had not reached
// it yet. Everything a path can answer is answered from the path.
func keepShared(facets db.NodeFacets, tagged map[int64]bool, node *model.Node, rel string, isDir bool) bool {
	// A tag names a node, so a row with no node behind it carries none — the
	// same reading Matches gives a driver object.
	if tagged != nil && (node == nil || !tagged[node.ID]) {
		return false
	}
	if !facets.Any() {
		return true
	}
	if node != nil {
		return facets.Matches(node)
	}
	if facets.NeedsNodeRow() {
		return false
	}
	return facets.MatchesPath(baseName(rel), isDir)
}

// taggedNodes is the set of nodes carrying EVERY tag asked for. nil means no
// tag was asked for at all; an empty map means it was, and nothing carries them.
//
// ⚠ The store answers at most 1000 nodes per tag, so on a drive where a tag is
// on more than that, a shared row carrying it can be missed. The SQL listings
// have no such ceiling — they test the tag inside the query — and closing it
// here means a store method that takes the id set rather than returning rows.
func (h *Shared) taggedNodes(ctx context.Context, tags []string) (map[int64]bool, error) {
	if len(tags) == 0 {
		return nil, nil
	}
	var out map[int64]bool
	for _, tag := range tags {
		nodes, err := h.Store.ListNodesByTag(ctx, tag, 1000)
		if err != nil {
			return nil, err
		}
		next := make(map[int64]bool, len(nodes))
		for _, n := range nodes {
			// The first tag seeds the set; every later one intersects with it.
			if out == nil || out[n.ID] {
				next[n.ID] = true
			}
		}
		out = next
	}
	return out, nil
}

func (h *Shared) project(ctx context.Context, st *model.Storage, g *model.FileGrant, rel string, granters map[int64]string) (map[string]any, *model.Node) {
	var entry map[string]any
	hash := pathkey.Hash(st.ID, normalizeDBPath(rel))
	node, err := h.Store.GetNodeByPath(ctx, st.ID, hash)
	if err != nil {
		node = nil
	}
	if node != nil {
		if th, terr := h.Store.GetThumbnail(ctx, node.ID); terr == nil {
			node.Thumb = th
		}
		// set=nil: the caller's visibility is already decided — they hold the
		// grant. Passing an acl.Set here would re-derive the same answer and
		// stamp `perm` from it; the grant's own level is the more precise
		// value and is written below.
		if projected := projectFileNodes(st.Name, []*model.Node{node}, false, nil); len(projected) == 1 {
			entry = projected[0]
		}
	}
	if entry == nil {
		node = nil
		typ := "file"
		if g.IsDir {
			typ = "dir"
		}
		entry = map[string]any{
			"path":     joinAdapterPath(st.Name, rel),
			"basename": baseName(rel),
			"type":     typ,
			"size":     int64(0),
			"storage":  st.Name,
		}
	}
	entry["perm"] = acl.ParseLevel(g.Level).String()
	entry["shared"] = true
	entry["shared_at"] = g.CreatedAt.UnixMilli()
	if g.IsGroup() && g.GroupName != "" {
		entry["via_group"] = g.GroupName
	}
	// Who shared it, next to when. The date alone left the column with an
	// initial-less avatar and a dash, and the grant has always known the answer.
	if g.CreatedBy != nil {
		entry["shared_by"] = *g.CreatedBy
		if name := h.granterName(ctx, granters, *g.CreatedBy); name != "" {
			entry["shared_by_name"] = name
		}
	}
	return entry, node
}

// granterName resolves the account that issued a grant to the name the column
// prints, memoised for the request.
//
// The display name ONLY, never the e-mail behind it. The other name lookups in
// this API fall back to the address when an account has set none, and this is
// the one listing whose whole purpose is to show one account's details to
// another: that fallback would hand every recipient of a share the granter's
// e-mail. An account with no display name is reported by id alone, and the
// client names it in the reader's own language.
func (h *Shared) granterName(ctx context.Context, cache map[int64]string, id int64) string {
	if name, looked := cache[id]; looked {
		return name
	}
	name := ""
	if u, err := h.Store.GetUser(ctx, id); err == nil && u != nil {
		name = strings.TrimSpace(u.DisplayName)
	}
	cache[id] = name
	return name
}

// attachStorageNames fills each node's Storage with the name of the storage
// holding it.
//
// Nodes returned outside a folder listing (starred, recently opened) carry
// only `storage_id`, and a client in multi-storage mode cannot build the
// `name://path` it needs to open a row from a numeric id — so those lists
// rendered names the user could click and nothing happened. One map lookup per
// node, one storage query per call.
func attachStorageNames(ctx context.Context, store db.Store, nodes []*model.Node) []*model.Node {
	if len(nodes) == 0 {
		return nodes
	}
	storages, err := store.ListEnabledStorages(ctx)
	if err != nil {
		return nodes
	}
	byID := make(map[int64]string, len(storages))
	for _, st := range storages {
		byID[st.ID] = st.Name
	}
	for _, n := range nodes {
		if n != nil {
			n.Storage = byID[n.StorageID]
		}
	}
	return nodes
}
