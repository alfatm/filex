# Backend gap — what the user UI needs that filex does not offer yet

Compiled from the reviews of stages 3–5 against `backend/internal/api/routes.go`,
`docs/SEARCH.md`, `docs/TRASH-VERSIONING.md`, `docs/SHARING.md`, `docs/MCP.md`.
Decide each row before writing the HTTP repository (stage 7).

## Repository ↔ API

| Repository method | filex today | Status | Decision needed |
|---|---|---|---|
| `listStorages` / `getStorage` | `GET /manager?q=index` returns storages; quota is per user (`GET /quota/me`) | ⚠️ | quota shown per storage in the UI → show the user quota instead, or add per-storage usage |
| `listFolder`, `resolvePath`, `getNode` | `GET /manager?storage&parent`, `?q=index&path`, `/stat` | ✅ | app `Node` needs `path`, `storageId`, `mime`; ids are int64 |
| `getPath` | none | ⚠️ | derive from `node.path` |
| `listPeople` | `GET /permissions` owner/admin only | ⚠️ | viewers get 403 → panel degrades to owner only |
| `search` | `POST /search {storage_id, query, limit, scope}`; tags via `tag:` syntax; snippet with `«»` markers; no total | ❌ | not supported: current-folder prefix, shared-only, modified, file type, owner, size, path, whole phrase, case sensitive, OCR toggle, paths/tags scopes, total count. Options: (a) backend adds `path_prefix`, `mime_group`, `mtime`, `size`, `owner` filters and a count; (b) client post-filters the ≤500 candidates; (c) hide unsupported controls behind capabilities |
| `assistantAsk` | none (only MCP `file_search` behind token scope) | ❌ | new endpoint: `POST /api/ai/assistant` SSE stream, server-side provider (OpenAI-compatible or Claude), tool-calling over the search index, conversation id; admin settings page for provider/key |
| `listRecent` | `GET /manager/recent` fed by `POST /manager/recent` on open | ⚠️ | UI must call `recordOpen(id)` on open/preview |
| `listStarred`, `setStarred` | `GET /manager/star/list`, `POST /manager/star` per node | ✅ | loop per id |
| `listShared` | `GET /manager/shared-with-me` | ✅ | |
| `listTrash` | `GET /manager/trash` flat, paged, per storage, `ttl_days` | ⚠️ | collapse subtree rows client-side or add `top_level_only`; banner shows `ttl_days` |
| `restore` | `POST /manager/restore {node_id}` | ✅ | loop per id |
| `deleteForever`, `emptyTrash` | admin only (`/api/admin/trash/*`) | ❌ | either user endpoints, or hide behind capabilities |
| `createFolder`, `rename` | `POST /manager action=newfolder|rename` path-based, 409 on conflict | ⚠️ | map 409 → `DUPLICATE_NAME` |
| `moveToTrash`, `move` | two paths: synchronous `POST /manager?q=delete\|move`, or the ops queue (`POST /api/files/move` + `GET /ops/{id}`) | ⚠️ | the repository uses the synchronous pair. A large subtree wants the queue, which means polling ops and refreshing on completion |
| `uploadFile` | `POST /manager?q=upload` (whole-body multipart), or the staged resumable path (`/upload/begin`, `/upload/{id}`, `/commit`) | ⚠️ | the repository uses the whole-body form: no progress, no resume, one request per file. Real progress means the staged path and a repository signature carrying `onProgress` / `signal`. Folder upload already rebuilds the tree client-side with `createFolder` before the transfers; over HTTP that is one round trip per new folder unless the server grows a bulk create |
| `createShareLink`, `removeShareLink` | `POST /share` → share id + url; `DELETE /share/{id}`; many shares per node | ⚠️ | node carries share list; UI shows first link, "Manage" for the rest |
| `listFolders` (Move picker) | none | ⚠️ | lazy tree via `listFolder` |
| `listFolder`/`listRecent`/… with a `ListingFilter` | listings take no filter | ❌ | needs `mime_group`, `mtime`, `size` and `owner` params on the listing endpoints — the same four the search row asks for; without them the filter chips cannot stay server-side |
| download of a folder or a selection | single-file `GET /read` only | ❌ | needs a zip endpoint; today the selection bar downloads files one by one and stays inert when a folder is selected |
| `listFilterPeople` (People chip options) | none | ❌ | needs "people I share with" (permission tables); today derived from the owners present in the mock |

## User settings modal

| What the modal writes | filex today | Status | Decision needed |
|---|---|---|---|
| profile: full name, display name, job title | `PATCH /api/auth/profile` takes `display_name`, `email`, `username`, `locale`, `timezone`, `avatar_url` | ⚠️ | wireable as it stands — the earlier claim here that there was no self-update was wrong. "Job title" has no column: add one or drop the field |
| account email + role badge | `/api/auth/me` carries them | ⚠️ | map onto the app's `User` (`email`, `role`) |
| avatar upload / removal | `avatar_url` on the profile PATCH — a small `data:image/…` URI, `""` removes it | ⚠️ | wireable as it stands; downscale before encoding (the admin profile page uses 160px) because the avatar rides inside every presence frame |
| password, 2FA | `POST /api/auth/password`, `/api/auth/totp/{enroll,verify,disable}` | ⚠️ | wireable as it stands |
| active sessions | none | ❌ | there is no session-listing endpoint; the row stays inert until one exists |
| notification switches | `GET/POST /api/notifications/settings` | ⚠️ | map the three app-level switches onto the server's setting names |
| theme, language, compact list, time zone, upload prefs | none | ✅ | client-only on purpose (localStorage `filex.app.settings`); revisit only if prefs must follow the user across devices |
| assistant enable + default mode | none | ❌ | belongs with the assistant endpoint row above; the provider and key stay admin-side |

## Addressing: how the app names a node

**Decided.** filex speaks two dialects on the same handler and the app takes
both, each where it is the only one that works:

- **A node's identity is its address**, `<storage name>://<path>` — what
  `?q=index`, every mutation verb and `/api/files/copy|move|delete` accept, and
  what the router already carries. `Node.id` IS that string, so the ancestor
  chain, the parent and the move target are derived rather than fetched.
- **The per-user metadata endpoints take a numeric node id** — star, tags,
  recent, versions, permissions, trash restore. Every listing row carries that
  id beside its path, so `HttpRepository` remembers it (`ids`, keyed by address)
  and hands it over where required. A node this session has never listed has no
  numeric id, and the repository says so instead of sending `node_id=NaN`.

What the path form buys, none of which the numeric listing offers: the caller's
visible storage list in every answer, `thumb_url`, per-entry `perm`, `read_only`,
the driver fallback on a cache miss, and the suppression of `.filex-trash`,
`.versions` and `.thumbs`. What it costs: an address is not stable across a
rename, so a folder renamed by another session 404s on the next listing. That
is accepted behaviour, not a gap.

### Added to the backend for this

| Change | Why |
|---|---|
| `GET /api/files/storages` → `{storages:[{name, read_only}]}` | the drive list was only reachable as a side effect of listing a folder, so a client could not draw its drive switcher before picking a drive. Same RBAC filter as `?q=index`; a root-confined caller sees only its own drive |
| `/api/files/search` results carry `storage` (the name) | a hit held a path with no way to address it — the identical dead-row bug the starred and recently-opened listings were already fixed for |

### Still applied client-side

| Question | What exists | Consequence |
|---|---|---|
| Listing filters | no query params | `HttpRepository` post-filters through `data/listingFilter.ts`, the same predicate the mock uses |
| Advanced search facets | `q`, `scope`, `limit` only | date window, type group, size band and owner are applied to the answer |
| Item count per folder | not returned | known only for the folder currently open (its own listing length) |
| Creation date | absent from the listing projection (`FileNode` carries `last_modified` only) | `Node.createdAt` is optional; the details panel omits the row rather than showing an invented date |
| `shared` per row | `/api/files/share` is per node | listing rows report `false`; the share modal reads the real state when it opens |

### No endpoint at all

| Repository method | State |
|---|---|
| `listActivity` | audit is admin-only; the panel's Activity tab is empty against a live server |
| `listFilterPeople` | no per-listing owner set to offer, so the People chip has no options |
| `assistantAsk` | no assistant endpoint; the capability is off, so the panel is unreachable |
| `deleteForever` / `emptyTrash` | `/api/admin/trash` only — an ordinary account cannot purge, and the capability is off |
| version authorship | `model.NodeVersion` records size and instant, not who wrote it |

## Capability snapshot

`GET /api/files/capabilities` reports what the storage DRIVERS can do, and the
app maps those field for field: `upload`, `move`, `copy`, `delete`, `mkdir`,
`search`, `versions`, `ocr`. Six more are the app's own axes and filex does not
report them, so `HttpRepository.capabilities` decides them from whether an
endpoint exists at all: `tags` and `permissions` on, `assistant`, `activity`,
`deleteForever` (admin-only there) and `folderDownload` off. Reporting them
from the server would remove the last hard-coded feature assumptions in the
client.

| Repository method | filex today | Status | Decision needed |
|---|---|---|---|
| `capabilities` | `GET /api/files/capabilities` | ✅ | report the six app-level axes so they stop being hard-coded |
| `setTags` | `POST /api/files/manager/tags {node_id, tags}` replaces the list; `GET …/tags?node_id` reads it | ✅ | the server lower-cases and drops tags over 64 chars, so the UI should show what came back rather than what was typed |

## Model gaps

- **Owner**: nodes have no owner. Decision from the product owner: "You" for
  everything in personal storages; for shared drives the owner is the group.
  Needs a `owner_group` on storages or nodes.
- **Shared drives with a group owner** do not exist in filex yet.
- **Folder item count** ("12 items") is not returned by the listing.
- **Activity tab**: audit is admin-only; per-node activity needs a user-visible
  endpoint (versions + comments + recent actions).
- **Capabilities**: the UI should read `GET /capabilities` to hide assistant,
  content search, OCR, delete-forever when the server lacks them.
