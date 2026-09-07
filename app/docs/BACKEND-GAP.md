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
| `moveToTrash`, `move` | async ops (`/ops/{id}`) | ⚠️ | store must poll ops and refresh on completion |
| `uploadFile` | staged resumable upload (begin / put / commit) | ❌ | repository signature `upload(parent, File, onProgress, signal)`; folder upload needs subfolder creation |
| `createShareLink`, `removeShareLink` | `POST /share` → share id + url; `DELETE /share/{id}`; many shares per node | ⚠️ | node carries share list; UI shows first link, "Manage" for the rest |
| `listFolders` (Move picker) | none | ⚠️ | lazy tree via `listFolder` |

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
