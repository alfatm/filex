// Package handlers — activity.go
//
// GET /api/files/activity?path=<adapter>://<rel>&limit=50  (auth)
//
// What has happened to ONE file. Every write surface in filex already emits a
// canonical event (`file.uploaded`, `file.updated`, `file.moved`,
// `file.trashed`, `file.deleted`, `share.created`) and every one of them is
// persisted — but only as a bell entry scoped to whoever acted, with the file
// buried inside meta_json. So the question a details panel asks, "what happened
// to THIS file", had no way to be asked at all: the app's Activity tab shipped
// against the mock and rendered empty against a live server.
//
// Migration 00034 lifted the node reference into columns; this reads them.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/brf-tech/filex/backend/internal/acl"
	"github.com/brf-tech/filex/backend/internal/confine"
	"github.com/brf-tech/filex/backend/internal/db"
	"github.com/brf-tech/filex/backend/internal/model"
)

// Activity serves the per-node event feed.
type Activity struct {
	Store db.Store
	ACL   *acl.Resolver
}

// NewActivity constructs the handler.
func NewActivity(store db.Store) *Activity { return &Activity{Store: store} }

// AttachACL wires the RBAC resolver: the feed says who touched a file, so it is
// readable by whoever may read the file itself and nobody else.
func (h *Activity) AttachACL(r *acl.Resolver) { h.ACL = r }

// activityLimit is the default and the ceiling. A details panel shows a short
// history; anything longer belongs to the admin audit page.
const activityLimit = 50

// activityMetaFields is the whole of meta_json this feed passes on: `from` and
// `to` are what tell a rename from a move, `origin` names the surface that
// wrote. It is a whitelist and not a list of things to strip, because meta_json
// is a BELL payload and carries whatever the emitting surface put there —
// `share.created` puts the share's TOKEN in it (notify.ShareRef), so dropping
// only `actor` and `node` handed the credential for a public link, anonymous
// drop links included, to every account holding viewer on the file. A whitelist
// also cannot leak whatever field a future emitter adds.
var activityMetaFields = []string{"from", "to", "origin"}

// activityEvent is one row on the wire. `meta` is the event's own payload —
// `from`/`to` on a move, `origin` everywhere — which is what lets a client tell
// a rename from a move without a second vocabulary here.
type activityEvent struct {
	ID        int64          `json:"id"`
	Event     string         `json:"event"`
	At        time.Time      `json:"at"`
	ActorID   *int64         `json:"actor_id,omitempty"`
	ActorName string         `json:"actor_name,omitempty"`
	Meta      map[string]any `json:"meta,omitempty"`
}

// List answers the feed for the node named by ?path.
func (h *Activity) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	adapter, rel := splitAdapterPath(q.Get("path"))
	if adapter == "" || rel == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path required, as <storage>://<path>"})
		return
	}
	st, err := h.Store.GetStorageByName(r.Context(), adapter)
	if err != nil || st == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errUnknownAdapter(adapter).Error()})
		return
	}
	clean := normalizeDBPath(rel)
	if root, ok := confine.RootFrom(r.Context()); ok && !root.Within(st.Name, clean) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "path outside confined root"})
		return
	}
	// ≥viewer: the feed names the people who wrote to a file, so it is exactly
	// as readable as the file. A caller who cannot see the file gets 403 rather
	// than an empty list — an empty list would be an answer about whether the
	// file exists.
	if h.ACL != nil && !aclAllowID(r.Context(), h.ACL, h.Store, st.ID, strings.Trim(clean, "/"), acl.LevelViewer) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "insufficient permission"})
		return
	}

	limit := activityLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= activityLimit {
			limit = n
		}
	}
	rows, err := h.Store.ListNodeEvents(r.Context(), st.ID, clean, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": h.project(r.Context(), rows)})
}

// project turns notification rows into the wire shape, naming each actor once.
//
// The actor is read from meta_json rather than from `user_id`: user_id scopes
// the BELL (whose notification list the row belongs in) and the two are not the
// same question — a row broadcast to the admins has no user_id at all, and it
// still had someone perform it.
func (h *Activity) project(ctx context.Context, rows []*model.Notification) []activityEvent {
	names := map[int64]string{}
	out := make([]activityEvent, 0, len(rows))
	for _, row := range rows {
		e := activityEvent{ID: row.ID, Event: row.Event, At: row.CreatedAt}
		var meta struct {
			Actor *struct {
				ID int64 `json:"id"`
			} `json:"actor"`
		}
		if len(row.MetaJSON) > 0 {
			_ = json.Unmarshal(row.MetaJSON, &meta)
			var free map[string]any
			if json.Unmarshal(row.MetaJSON, &free) == nil {
				kept := make(map[string]any, len(activityMetaFields))
				for _, k := range activityMetaFields {
					if v, ok := free[k]; ok {
						kept[k] = v
					}
				}
				if len(kept) > 0 {
					e.Meta = kept
				}
			}
		}
		if meta.Actor != nil && meta.Actor.ID > 0 {
			id := meta.Actor.ID
			e.ActorID = &id
			name, seen := names[id]
			if !seen {
				// ⚠ The display name ONLY — the e-mail recorded in the row is
				// not a fallback for it. Anybody who may read a folder may read
				// its activity, so naming an account by its address handed every
				// reader the addresses of the colleagues who had touched it. An
				// account that has set no display name comes back with the id and
				// no name, and the panel says who it is in the reader's own
				// language.
				if u, err := h.Store.GetUser(ctx, id); err == nil && u != nil {
					name = strings.TrimSpace(u.DisplayName)
				}
				names[id] = name
			}
			e.ActorName = name
		}
		out = append(out, e)
	}
	return out
}
