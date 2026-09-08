# Backend gap — what the user UI needs that filex does not offer yet

Compiled from the reviews of stages 3–5 against `backend/internal/api/routes.go`,
`docs/SEARCH.md`, `docs/TRASH-VERSIONING.md`, `docs/SHARING.md`, `docs/MCP.md`.
Decide each row before writing the HTTP repository (stage 7).

## Repository ↔ API

| Repository method | filex today | Status | Decision needed |
|---|---|---|---|
| `listStorages` / `getStorage` | `GET /api/files/storages` now carries `used_bytes`; the ceiling is still the account's (`GET /quota/me`) | ✅ | **added to the backend**: every drive card repeated the ACCOUNT's figure and called it that drive's. Each drive now answers for itself, measured against the one ceiling filex has |
| `listFolder`, `resolvePath`, `getNode` | `GET /manager?storage&parent`, `?q=index&path`, `/stat` | ✅ | app `Node` needs `path`, `storageId`, `mime`; ids are int64 |
| `getPath` | none | ⚠️ | derive from `node.path` |
| `listPeople` | `GET /permissions`, ≥viewer to read, owner to change | ✅ | **added to the backend**: reading the list was gated at owner, so everyone else opened "People with access" and saw themselves alone. The answer carries `can_manage`, and the modal renders read-only for anybody who does not have it |
| `search` | `POST /search {storage_id, query, limit, scope}` plus the facets `path_prefix`, `ext`, `modified_after`, `size_min`, `size_max`, `owner_id`; tags via `tag:` syntax; snippet with `«»` markers | ⚠️ | **added to the backend**: the date window, type group, size band, owner and current-folder scope are the server's work now, resolved against the node table and applied as an index restriction rather than sieved out of the first 100 hits. Still client-side or absent: the hand-typed custom size range, the free-text path prefix (it is typed in the FULL address space, `/demo/design/`, which the server has no form of), and a true total. Whole phrase is the server's work now (a quoted query); the case and OCR boxes were REMOVED rather than implemented — see the design spec §7 |
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
| profile: full name, display name, job title | `PATCH /api/auth/profile` takes `display_name`, `email`, `username`, `locale`, `timezone`, `avatar_url` and now `full_name`, `job_title` | ✅ | **added to the backend** (migration 00035): the two fields had no column, so the modal kept them in this browser's localStorage — a "profile" that did not follow the account to another machine. Both are optional: nullable, absent means "leave alone", an empty string clears |
| account email + role badge | `/api/auth/me` carries them | ⚠️ | map onto the app's `User` (`email`, `role`) |
| avatar upload / removal | `avatar_url` on the profile PATCH — a small `data:image/…` URI, `""` removes it | ⚠️ | wireable as it stands; downscale before encoding (the admin profile page uses 160px) because the avatar rides inside every presence frame |
| password, 2FA | `POST /api/auth/password`; TOTP under `/api/auth/totp/*` | ✅ | **the password change is wired**, gated on the realm's `change_password`. 2FA is deliberately NOT rebuilt here: the second factor belongs to the auth provider, and the app only reports its state |
| active sessions | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}` | ✅ | **added to the backend**: filex had recorded a row per sign-in since its first migration and never showed it to the person who made it. The row now carries the count, opens in place into the list, and ends one sign-in at a time; the session the app is calling with is marked and cannot be ended (that is what signing out is). `ip` and `user_agent` were also never WRITTEN — both login drivers passed empty strings — so they are filled from now on and older rows read "Unknown device" |
| notification switches | `GET/PATCH /api/notifications/settings` | ✅ | **the endpoint existed and nothing read it**: `notify.Send` inserted every row whatever the user had muted, so wiring the switches to it alone would have drawn a working-looking control over a preference no code consulted. The send path honours the matrix now. The three switches map onto `share.created`, `comment.added` and `file.uploaded`; `file.upload_failed` is deliberately NOT part of "finished uploads", and the app rewrites only those three keys so an event set elsewhere survives |
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
| the mute list is honoured in `notify.Send` | `notification_settings` has been writable since migration 00007 and was read by nothing. A muted event is inserted ALREADY READ rather than skipped, because the same notifications rows are what the per-file activity feed reads: dropping them would take a muted user's file history away from everybody. `in_app_enabled: false` silences that user's bell entirely; a user with no row wants everything, which is what the schema says |
| `users.full_name` + `users.job_title` (migration 00035) | the settings modal asked for both and the account row had nowhere to put them, so they lived in localStorage and did not follow the person. Nullable and optional — the full name is not the DISPLAY name, which is what other people see next to a file |
| every SQLite expiry comparison is UTC on both sides | `expires_at > CURRENT_TIMESTAMP` compares TEXT, modernc's driver writes a Go time WITH its zone offset ("2026-09-08 10:52 +0300 UTC+3"), and CURRENT_TIMESTAMP is UTC wall clock with no offset at all — so the offset was decoration and the two strings were not on the same clock. On a host at UTC+3 an expired session kept authenticating for three hours and the sweeper walked past it; west of UTC live sessions died early and a revoked share link stayed open. Sessions, shares and staged uploads now write and compare in UTC, where the text prefix IS the instant. Rows written before the change keep their old zone until rewritten (sessions age out inside their 12h TTL). PostgreSQL was never affected: `TIMESTAMPTZ` + `NOW()` |
| `GET /api/auth/sessions` + `DELETE /api/auth/sessions/{id}` | the sessions table has held ip, user agent, creation and expiry since migration 00001, and the only thing that could act on it was the password change's "revoke every other session" — blind, and offered to nobody. Both routes are scoped by the context principal rather than by a parameter, so there is no id to tamper with; the caller's own session is refused rather than deleted. The login drivers now record the address and the user agent they were called with, carried down on the context because a driver has no request of its own |
| `GET /api/auth/methods` | an ordinary user could not find out how they sign in: `/api/auth/me` carries a numeric `provider_id` and nothing else, and `/api/admin/auth-providers` is supertenant-only because it holds issuers and bind credentials. This one is scoped to the caller and carries a name and two flags — realm, whether it allows a password change, and their own TOTP state |
| read-only is checked on the ops queue's SOURCE | the flag meant two different things depending on which door the request came through: `?q=move\|delete` refused a read-only storage from the start, the queue never asked. So the same delete answered 403 in one place and 202 in the other — and the 202 was the one that emptied the depo into its trash. Copy is deliberately still allowed: it only reads its source |
| a move INTO A STORAGE ROOT no longer soft-deletes the node | `applyDBMove` stripped the leading slash before taking `path.Dir`, so a destination at the root came out as `"."` — a directory in no index — and the miss fell into the branch that flags the row deleted. The bytes arrived; the folder left every listing and appeared in the trash as a row whose bytes were never in `.filex-trash`, so Restore could not undo it either. Both callers shared the helper, so the synchronous move was breaking the same way |
| a fully quoted query is a phrase search inside files | the advanced form's "whole phrase" box had nothing behind it: the app never sent it and the content side ran an AND match, which finds a document that says "annual" in one paragraph and "report" in another. A quoted query now becomes a Bleve `match_phrase` — no index change, because the default text mapping already records term positions (measured before writing it). Deliberately content-only: `PrepareQuery` strips quotes before the NAME side sees them, and it must, since filename matching is subsequence matching by design (`invoice 2026` → `invoice_2026.pdf`, issue #15) |
| reading `GET /api/files/permissions` needs viewer, not owner | "who else can see this file" is a question anybody who can open the file may ask, and it was answered only to owners — so a shared folder's access panel showed a non-owner nothing but their own row. The mutating verbs keep the owner bar, and the answer says `can_manage` so the client renders a list instead of controls that would 403. Below viewer it is still refused: naming people to somebody who cannot open the file is a leak of its own |
| `used_bytes` per drive on `GET /api/files/storages` | the drive cards drew their figure from `/quota/me`, which meters the ACCOUNT — so two drives showed one number twice, each labelled as that drive's. One grouped SUM over the node table answers per drive; the ceiling stays the account's, because that is the only ceiling filex has. Trashed files count (the bytes are still on the driver), directory rows do not (they carry an aggregate of their subtree) |
| `node_versions.created_by` (migration 00036) | the versions panel named the person LOOKING at it as the author of every revision, including ones somebody else wrote — the client had no author to show and filled the column with the current user. Recorded from the request's principal at snapshot time; a background snapshot has no principal and records none. No backfill, so older revisions show a date and a size and no name |
| `created_at`, `item_count` and `shared` on listing rows | three columns the app drew from nothing. The creation date was in `model.Node` all along and the listing projection simply did not carry it. The item count did not exist: a folder showed the word "Folder" where the design shows "12 items", and counting client-side is impossible — the listing holds the folder, not its contents. `shared` was hard-coded `false` on every row, so the folder badge that says "this is reachable by link" never lit and the only way to find out was to open the share modal file by file. Two grouped queries per page (`ChildCounts`, `SharedNodeIDs`), the shape `attachOwners` already established, not a query per row |
| `GET /api/files/manager/trash?top_level_only=1` | the trash listing is flat by construction: a deleted folder drags its cached descendants in as rows of their own, so the user saw the folder and every file inside it, each offering a Restore only the folder's own restore performs. Collapsing them client-side would mean guessing parentage from path prefixes; the server knows it. Opt-in, so the admin trash screen and the purge scan still see every row |

### Still applied client-side

| Question | What exists | Consequence |
|---|---|---|
| Listing filters | no query params | `HttpRepository` post-filters through `data/listingFilter.ts`, the same predicate the mock uses |
| Advanced search facets | `q`, `scope`, `limit`, the six facet fields, and a quoted query for the phrase box | what remains here is the hand-typed size range and the free-text path prefix |
| Item count per folder on an RBAC storage | one grouped query cannot apply `CanSee` per child | counted for admins and RBAC-off storages; a caller holding grants gets no count at all, because a traversal folder would otherwise advertise entries opening it does not show |
| Modification date of a folder ROOT | a storage root is not a node and has none | `Node.modifiedAt` is optional too; the formatters render an em dash. Anything filex did date keeps its date |
| The link BEHIND a shared row | `GET /share` is per node and refuses below editor | the row says THAT a node is shared; the URL is a credential, so the details panel and the share modal ask for it per node when they open. filex lists a non-admin only the links they minted, so somebody else's link reads as "none of yours" |

### No endpoint at all

| Repository method | State |
|---|---|
| `assistantAsk` | no assistant endpoint; the capability is off, so the panel is unreachable |
| version authorship | recorded from migration 00036 on. Revisions taken before it have no author and are shown without a name — there is no backfill, because nobody wrote one down |

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
- **Activity tab**: audit is admin-only; per-node activity needs a user-visible
  endpoint (versions + comments + recent actions).
- **Capabilities**: the UI should read `GET /capabilities` to hide assistant,
  content search, delete-forever when the server lacks them. OCR is no longer
  among them: it is an extraction-time property (text found in an image is
  content like any other), so there is no OCR surface for a flag to hide.
