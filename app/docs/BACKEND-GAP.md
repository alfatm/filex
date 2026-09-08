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
| `search` | `POST /search {storage_id, query, limit, scope}` plus the facets `path_prefix`, `ext`, `modified_after`, `size_min`, `size_max`, `owner_id`; tags via `tag:` syntax; snippet with `«»` markers | ⚠️ | **added to the backend**: the date window, type group, size band, owner and current-folder scope are the server's work now, resolved against the node table and applied as an index restriction rather than sieved out of the first 100 hits. Still client-side or absent: the hand-typed custom size range, the free-text path prefix (it is typed in the FULL address space, `/demo/design/`, which the server has no form of), whole phrase, case sensitive, the OCR toggle, and a true total |
| `assistantAsk` | none (only MCP `file_search` behind token scope) | ❌ | new endpoint: `POST /api/ai/assistant` SSE stream, server-side provider (OpenAI-compatible or Claude), tool-calling over the search index, conversation id; admin settings page for provider/key |
| `listRecent` | `GET /manager/recent` fed by `POST /manager/recent` on open | ⚠️ | UI must call `recordOpen(id)` on open/preview |
| `listActivity` | `GET /api/files/activity?path=…` | ✅ | **added to the backend**: the events were all being recorded already, as bell entries with the file buried in `meta_json`. Two indexed columns make them findable per node. Readable by whoever may read the file (≥viewer). Keyed by path, so a rename splits a file's history across its two names — and there is no backfill, so history starts at the upgrade |
| `listStarred`, `setStarred` | `GET /manager/star/list`, `POST /manager/star` per node | ✅ | loop per id |
| `listShared` | `GET /manager/shared-with-me` | ✅ | |
| `listTrash` | `GET /manager/trash` paged, per storage, `ttl_days`, and `top_level_only=1` for one row per deletion | ✅ | **added to the backend**: the flat listing showed a deleted folder AND every file inside it, each offering a Restore only the folder's own restore performs. The app passes the flag; banner shows `ttl_days` |
| `restore` | `POST /manager/restore {node_id}` | ✅ | loop per id |
| `deleteForever`, `emptyTrash` | `DELETE /manager/trash/{id}` and `POST /manager/trash/empty` | ✅ | **added to the backend**: the trash was a room the user could put things into and never take anything out of. Both are scoped to what the caller could have deleted (confinement + ≥editor on the original path); `empty` purges top-level rows in bounded rounds and reports `more`, which `HttpRepository.emptyTrash` loops on while it is still making progress |
| `createFolder`, `rename` | `POST /manager action=newfolder|rename` path-based, 409 on conflict | ⚠️ | map 409 → `DUPLICATE_NAME` |
| `moveToTrash`, `move` | the ops queue (`POST /api/files/move\|delete` + `GET /ops/{id}`) | ✅ | **the repository now uses the queue**, as copy already did. The synchronous `?q=move\|delete` held one request open for the whole subtree, which is what a proxy cuts at sixty seconds and reports as a failure for work that was going to succeed; a submit answers in milliseconds and each poll is its own short request. The queued delete is the identical soft delete (`trash.Put` + retag), so nothing about the trash changes. A job still running when the app stops waiting raises `OPERATION_PENDING`: the listing refreshes, the toast says it is still running, and no Undo is armed for half a move |
| `copy` | `POST /api/files/copy` + the ops queue; the handler refuses a copy whose source and target sit on different adapters | ⚠️ | cross-storage copy is out of scope for now (product decision): the destination picker keeps the other storages listed and greyed rather than pretending they are not there |
| `uploadFile` | the staged resumable path (`/upload/begin`, `PUT /upload/{id}`, `/commit`) | ⚠️ | **the repository uses the staged path**: 1 MiB chunks, real progress per accepted chunk, and the commit's op awaited so a finished row means the storage has the file. Still open: resuming after a page reload needs the session ids persisted, and there is no cancel — `GET /upload/{id}` would answer the offset either way. Folder upload still rebuilds the tree with `createFolder`, one round trip per new folder |
| `createShareLink`, `removeShareLink` | `POST /share` → share id + url; `DELETE /share/{id}`; many shares per node | ⚠️ | node carries share list; UI shows first link, "Manage" for the rest |
| `listFolders` (Move picker) | none | ⚠️ | lazy tree via `listFolder` |
| `listFolder`/`listRecent`/… with a `ListingFilter` | listings take no filter | ❌ | needs `mime_group`, `mtime`, `size` and `owner` params on the listing endpoints — the same four the search row asks for; without them the filter chips cannot stay server-side |
| download of a folder or a selection | `GET /api/files/download/zip?path=…&path=…`, streamed | ✅ | **added to the backend**: a zip built on the fly from any mix of files and folders. A GET, because the download has to be a navigation for the browser to own the save dialog and the disk write |
| `listFilterPeople` (People chip options) | derived from the `owner_id`/`owner_name` the listings now carry | ✅ | the chip offers exactly the people a filter over those rows could match. No endpoint on purpose: a `DISTINCT` over the node table would name owners of folders the caller cannot open |

## User settings modal

| What the modal writes | filex today | Status | Decision needed |
|---|---|---|---|
| profile: full name, display name, job title | `PATCH /api/auth/profile` takes `display_name`, `email`, `username`, `locale`, `timezone`, `avatar_url` | ⚠️ | wireable as it stands — the earlier claim here that there was no self-update was wrong. "Job title" has no column: add one or drop the field |
| account email + role badge | `/api/auth/me` carries them | ⚠️ | map onto the app's `User` (`email`, `role`) |
| avatar upload / removal | `avatar_url` on the profile PATCH — a small `data:image/…` URI, `""` removes it | ⚠️ | wireable as it stands; downscale before encoding (the admin profile page uses 160px) because the avatar rides inside every presence frame |
| password, 2FA | `POST /api/auth/password`; TOTP under `/api/auth/totp/*` | ✅ | **the password change is wired**, gated on the realm's `change_password`. 2FA is deliberately NOT rebuilt here: the second factor belongs to the auth provider, and the app only reports its state |
| active sessions | none | ❌ | there is no session-listing endpoint; the row stays inert until one exists. Note the password change revokes every OTHER session, which the form says out loud |
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
| `GET /api/files/download/zip` | the single-file `/read` was all there was, so the selection bar downloaded a selection one file at a time and went inert the moment a folder was in it. Streams `archive/zip` straight to the response; roots are stat'ed and authorised before the first byte, because after that the status is 200 whatever happens |
| `DELETE /manager/trash/{id}` and `POST /manager/trash/empty` | purging was an admin action, so an ordinary account's trash only ever filled up: items sat there until the retention sweep and the app had to keep "Delete forever" and "Empty trash" switched off. The dangerous half was the guard, not the purge — `trash.PurgeOne` deletes the bytes at the row's CURRENT path, which for a LIVE row is where the file still is, and nothing checked that the node was in the trash at all. It does now, which protects the admin route too |
| `owner_id` + `owner_name` on listing rows | the owner has been in the node table since migration 00004 and never left it: the listing projection did not carry it, so the app filled its Owner column with "You" for every row, on a shared drive included. One join for the whole page, not `GetNodeOwner` per file, and it carries the NAME because a column that renders a number is a column nobody reads |
| search facets on `POST /api/files/search` | the index knows a document's name, path, mime and type and nothing else, so every other filter the advanced form offers was applied to the ANSWER — the first 100 hits for the text, minus what did not fit. Files ranked past the window were invisible and indistinguishable from "there are none". Now resolved against the node table and applied as an index restriction (the `tag:` mechanism), with an exact pass over the results for the paths that never consult the index |
| `GET /api/files/activity` + migration 00034 | the details panel's Activity tab had no endpoint behind it and rendered empty against a live server. filex had in fact recorded every file event since notifications existed — but only as a BELL entry scoped to whoever acted, with the file buried in `meta_json`, so "what happened to THIS file" could not be asked without scanning and parsing the whole table. The migration lifts the node reference into two indexed columns; no backfill, so history starts at the upgrade |
| `pending_ops.user_id` | the queue's worker runs on a server-lifetime context, so every event a queued move, delete or upload-commit emitted named NO actor — and the feed above would have said "somebody moved it to Docs" for the most common operations in the app. The submitter's id is written at submit time, where there still is a request, and put back on the context the steps run under |
| `GET /api/auth/methods` | an ordinary user could not find out how they sign in: `/api/auth/me` carries a numeric `provider_id` and nothing else, and `/api/admin/auth-providers` is supertenant-only because it holds issuers and bind credentials. This one is scoped to the caller and carries a name and two flags — realm, whether it allows a password change, and their own TOTP state |
| read-only is checked on the ops queue's SOURCE | the flag meant two different things depending on which door the request came through: `?q=move\|delete` refused a read-only storage from the start, the queue never asked. So the same delete answered 403 in one place and 202 in the other — and the 202 was the one that emptied the depo into its trash. Copy is deliberately still allowed: it only reads its source |
| a move INTO A STORAGE ROOT no longer soft-deletes the node | `applyDBMove` stripped the leading slash before taking `path.Dir`, so a destination at the root came out as `"."` — a directory in no index — and the miss fell into the branch that flags the row deleted. The bytes arrived; the folder left every listing and appeared in the trash as a row whose bytes were never in `.filex-trash`, so Restore could not undo it either. Both callers shared the helper, so the synchronous move was breaking the same way |
| `GET /api/files/manager/trash?top_level_only=1` | the trash listing is flat by construction: a deleted folder drags its cached descendants in as rows of their own, so the user saw the folder and every file inside it, each offering a Restore only the folder's own restore performs. Collapsing them client-side would mean guessing parentage from path prefixes; the server knows it. Opt-in, so the admin trash screen and the purge scan still see every row |

### Still applied client-side

| Question | What exists | Consequence |
|---|---|---|
| Listing filters | no query params | `HttpRepository` post-filters through `data/listingFilter.ts`, the same predicate the mock uses |
| Advanced search facets | `q`, `scope`, `limit`, and the six facet fields | what remains here is the hand-typed size range and the free-text path prefix; whole phrase, case sensitivity and OCR have no server form at all |
| Item count per folder | not returned | known only for the folder currently open (its own listing length); everywhere else a folder shows its TYPE instead of a count, because "0 items" for a folder nobody counted is a lie |
| Creation date | absent from the listing projection (`FileNode` carries `last_modified` only) | `Node.createdAt` is optional; the details panel omits the row rather than showing an invented date |
| Modification date of a folder ROOT | a storage root is not a node and has none | `Node.modifiedAt` is optional too; the formatters render an em dash. Anything filex did date keeps its date |
| Per-drive usage | `/api/files/quota/me` meters the ACCOUNT, not the drive | every drive reports the same figure. An account with no ceiling (`unlimited`) shows what it has used and no progress bar — a bar that can never fill says nothing |
| `shared` per row | `/api/files/share` is per node | listing rows report `false`; the share modal reads the real state when it opens |

### No endpoint at all

| Repository method | State |
|---|---|
| `assistantAsk` | no assistant endpoint; the capability is off, so the panel is unreachable |
| version authorship | `model.NodeVersion` records size and instant, not who wrote it |

## Capability snapshot

`GET /api/files/capabilities` reports what the storage DRIVERS can do, and the
app maps those field for field: `upload`, `move`, `copy`, `delete`, `mkdir`,
`search`, `versions`, `ocr`. Six more are the app's own axes and filex does not
report them, so `HttpRepository.capabilities` decides them from whether an
endpoint exists at all: `tags`, `permissions` and `folderDownload` on,
`assistant` off; `activity` and `deleteForever` are now on for the same reason
as `folderDownload` — the endpoints they need exist. Reporting them
from the server would remove the last hard-coded feature assumptions in the
client.

| Repository method | filex today | Status | Decision needed |
|---|---|---|---|
| `capabilities` | `GET /api/files/capabilities` | ✅ | report the six app-level axes so they stop being hard-coded. `folderDownload` and `deleteForever` are decided by the HTTP repository from the fact that their endpoints exist |
| `setTags` | `POST /api/files/manager/tags {node_id, tags}` replaces the list; `GET …/tags?node_id` reads it | ✅ | the server lower-cases and drops tags over 64 chars, so the UI should show what came back rather than what was typed |

## Model gaps

- **Owner**: nodes DO have one — `nodes.owner_id`, written by quota accounting
  on every upload and save since migration 00004. The earlier claim here that
  there was none was wrong. The listing projection now carries `owner_id` and
  `owner_name`, so a shared drive shows who put each file there instead of "You"
  for everything. What is still missing is the GROUP owner the product decision
  asks for on shared drives; a node a storage SYNC found has no owner at all and
  falls back to the caller, which is the honest reading of "everything you can
  see, you can see".
- **Shared drives with a group owner** do not exist in filex yet.
- **Folder item count** ("12 items") is not returned by the listing.
- **Activity tab**: audit is admin-only; per-node activity needs a user-visible
  endpoint (versions + comments + recent actions).
- **Capabilities**: the UI should read `GET /capabilities` to hide assistant,
  content search, OCR, delete-forever when the server lacks them.
