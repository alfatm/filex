# Backend gap — what the user UI needs that filex does not offer yet

Compiled from the reviews of stages 3–5 against `backend/internal/api/routes.go`,
`docs/SEARCH.md`, `docs/TRASH-VERSIONING.md`, `docs/SHARING.md`, `docs/MCP.md`,
and kept in step with the code since. ✅ means the app and filex agree; ⚠️ means
something is still done in the client, or done in a way worth knowing about; ❌
means there is nothing on the server to talk to.

## Hosting: filex serves this app ✅

**Closed.** The earlier decision here — *"the dev stand is the whole story for
now; embedding the app in the binary is a later wave"* — was reversed: the app
is embedded in the binary and mounted at the **root**. An apex visit is a person
wanting their files; the admin console keeps `/admin/`, and `/` was a 302 to it
until this moved.

What carries it:

| Piece | Where |
|---|---|
| `//go:embed all:admin all:web all:app` | `backend/embed/embed.go` |
| `/` + the root catch-all, wired LAST in `wireStatic` | `backend/internal/api/routes.go` |
| built + staged into `embed/app` | `docker/Dockerfile` |
| built + copied for the goreleaser binaries | `.github/workflows/release.yml` (`binaries`) |
| built + copied for a local `pnpm run build:all` | `scripts/sync-embed.mjs`, `package.json` |
| `.keep` placeholder so a CLI-only build compiles | `desktop/scripts/fetch-cli.mjs` |

Four properties of that wiring are deliberate:

- **`/api/*` answers 404 on its own.** Measured, not assumed: with only the
  catch-all in place, `/api/nope` came back `200 text/html` — the SPA's
  index.html — because the API surface is registered endpoint by endpoint
  rather than behind one blanket subrouter. A removed or mistyped endpoint has
  to stay a 404, or it reaches the caller as "unexpected token <" from a JSON
  parser.
- **The root catch-all is registered LAST.** chi prefers the more specific
  pattern, so `/api/…`, `/admin/…`, `/drive/…`, `/s/{token}`, `/d/{token}`,
  `/dav`, `/s3` and `/embed.js` all still win. The cost is real and worth
  stating: anything NOT registered now answers the app's `index.html` with
  **200 instead of 404**, and a new top-level route does not exist until it is
  registered. Paths that look like files still 404 — `spaHandler` checks
  `hasAssetExt` before falling back.
- **`/files/edit` stays the ADMIN editor.** It is registered above the
  catch-all, which shadows the app's own `/files/:path*` for a folder literally
  named `edit`. Left that way on purpose: the editor URL is an existing
  contract (`openPageBase` in the admin SPA), and a folder named `edit` at a
  drive root is the rarer case.
- **An empty `embed/app` falls back to the console, and never 500s.** The
  directory is created by every build pipeline whether or not the app was
  built, and `stripPrefix` only rejects an *empty* one — so `wireStatic` probes
  for `index.html`, and a build without the app restores the old `/` → `/admin/`
  redirect instead of serving a broken page.

`base` lives in `app/vite.config.ts` and the router reads it back through
`import.meta.env.BASE_URL`, so the two cannot drift.

The app ships inside the image: `docker/Dockerfile` builds it and stages it
into `embed/app`, so `docker compose up --build` serves it at the apex with no
second container. `BUILD_APP=0` leaves it out and gives the `/` → `/admin/`
redirect above. The stand that used to run it on `:5175` behind `vite preview`
is gone; what survives of that arrangement is the live e2e suite
(`node e2e/run.mjs app --build`), which serves a BUILD rather than the dev
server, because the build is what ships. There is no mock repository left to
ship by accident either: the app has one data source, `src/data/http/`, so
`VITE_FILEX_API` now only says where the server is.

## Repository ↔ API

| Repository method | filex today | Status | Decision needed |
|---|---|---|---|
| `listStorages` / `getStorage` | `GET /api/files/storages` now carries `used_bytes`; the ceiling is still the account's (`GET /quota/me`) | ✅ | **added to the backend**: every drive card repeated the ACCOUNT's figure and called it that drive's. Each drive now answers for itself, measured against the one ceiling filex has |
| `listFolder`, `resolvePath`, `getNode` | `GET /manager?storage&parent`, `?q=index&path`, `/stat` | ✅ | app `Node` needs `path`, `storageId`, `mime`; ids are int64 |
| `getPath` | none needed | ✅ | derived, not fetched: every ancestor is a prefix of the node's own address, so the chain costs no requests |
| `listPeople` | `GET /permissions`, ≥viewer to read, owner to change | ✅ | **added to the backend**: reading the list was gated at owner, so everyone else opened "People with access" and saw themselves alone. The answer carries `can_manage`, and the modal renders read-only for anybody who does not have it |
| `search` | `POST /search {storage_id, query, limit, scope}` plus the facets `path_prefix`, `ext`, `modified_after`, `size_min`, `size_max`, `owner_id`; tags via `tag:` syntax; snippet with `«»` markers | ⚠️ | **added to the backend**: the date window, type group, size band, owner and current-folder scope are the server's work now, resolved against the node table and applied as an index restriction rather than sieved out of the first 100 hits. Still client-side or absent: the hand-typed custom size range, the free-text path prefix (it is typed in the FULL address space, `/demo/design/`, which the server has no form of), and a true total. Whole phrase is the server's work now (a quoted query); the case and OCR boxes were REMOVED rather than implemented — see the design spec §7. Three controls of the form drew a selected button and answered exactly what "All files" answers, because `ParseScope` knew `name`, `content` and `all` and nothing else. All three work now on both sides: `path`/`paths` is an alias of the name scope (which already consults `path` and `path_norm`, so it matches an address without reading file contents), `tag`/`tags` is a scope answered from `node_meta` rather than the index because tags change without the node being re-indexed, and the client sends each of them by name — `SEARCH_SCOPES_WIRE` in `http/repository.ts`, with "All" travelling as no scope at all because that is the server's default. **Search in → Shared files** is the `shared_only` facet, sent when that button is chosen: it means the files this account has published a still-open link to — the same thing the `shared` badge means in every listing — and the three locales say so rather than "files shared with you", which is a different page |
| `assistantAsk` | `POST /api/assistant/sessions/{id}/turn` (SSE), `GET /api/assistant/status`, `GET/PUT/POST /api/admin/assistant/provider[/test]` | ⚠️ | **added to the backend**: one configured provider (openai-compatible — which covers vLLM, Ollama and any gateway — or Anthropic), its key sealed with `internal/secretbox` and never read back, the standing instructions in `internal/assistant/prompt.md`, embedded into the binary at build time, the answer streamed so stopping half-way is real, and both halves of the exchange stored (a stopped answer stays, marked). Two limits per account: one turn at a time, and `assistant.turns_per_minute` as the loop-breaker. It now has READ tools and PLAN tools (below). A search emits `hits` — the rows it found, as the tool reports them — so the panel's result cards are drawn from the server and stored with the answer; the mode chip travels as `mode` and becomes one sentence of scope guidance for that turn. So does what the person has on screen, as `context`: the page, the open folder, the selected addresses, the search page's query, settings, count and first hits — appended to that question the same way, not stored, so "these files" and "this folder" mean something to the model |
| assistant READ tools | `list_storages`, `list_folder`, `search_files`, `read_file` — all through `aiOps`, the same ACL-checked core the MCP server uses | ✅ | **added to the backend**: the assistant sees exactly what the person asking could open themselves, because it goes through the one chokepoint (`resolveStorage`) that asserts ≥viewer on every path. `read_file` refuses unless `assistant_read_grants` holds that EXACT path for that conversation (migration 00038): no prefix, no folder form, no "approve everything" — the schema cannot express one. The request is served as an interrupt: the card goes down the stream, the turn stands still, the click answers it (`decision: allow\|deny`) and the same tool call returns the contents or a refusal — no message is typed for it. PDF and office files are read through the search index's extractors; pictures have `read_image_text` (OCR via tesseract) and `view_image` (the picture itself, scaled, attached to the tool result for a vision-capable model). One turn may call tools 8 times before it has to answer |
| assistant WRITE tools (tag, move, restore a version, revoke a link, empty trash) | `plan_tags`, `plan_move`, `plan_restore_version`, `plan_revoke_share`, `plan_empty_trash` + `POST /plans/{id}/approve|cancel` (migration 00039) | ✅ | **added to the backend**, and the shape is the safety property: the model's tools do not change anything, they WRITE A PLAN — items resolved to node ids and fingerprinted — and the server executes the stored plan once the person approves it in the panel. The model is not in the loop at execution time. An item whose fingerprint moved is skipped and reported; a plan runs at most once — the row is claimed out of `pending` BEFORE any work starts, and the work then runs on a context detached from the request, so a client that hangs up mid-plan cannot leave it half-done and still approvable; caps are 50 items, 1000 for tags. Permissions are checked twice, as the person: once while the plan is built and again at execution, because a grant can be withdrawn in between. `/api/files/versions` guards its own node as well now (≥viewer to list a timeline, ≥editor to snapshot or restore), so the executor's own check is the second rung rather than cover for a hole in that surface. `plan_move` puts items into one folder on the same drive, creating it first as its own line of the plan, and never overwrites: a name already taken in the destination (checked against the DRIVER, not the cache) is skipped as `taken`. Deliberately absent: any tool that writes, renames or deletes a live file, or touches permissions |
| assistant conversation names | the turn stream's `{"type":"title"}` frame; `PATCH /api/assistant/sessions/{id}` for a name somebody types | ✅ | **added to the backend**: an unnamed conversation is named as its first turn ends, by a SEPARATE model call under its own prompt (`internal/assistant/title.go`). ⚠ The call is sent the QUESTION and never the answer — the title is the one part of a conversation an administrator can see, and the answer is where the file names are. A name that carries a path, an address or a file name is dropped rather than stored, and a name the person typed (`title_manual`) is never touched. The name arrives on the same stream as the answer, so the chat list needs no refetch |
| `listRecent` | `GET /manager/recent` fed by `POST /manager/recent` on open | ✅ | the preview modal records every file it shows (`recordOpen`), which is what Recent orders by. **The open date is on the wire** — the row is the node plus `opened_at`, RFC3339, read off `user_node_meta` — because without it the client had only the file's mtime to group by and "Today" meant "written today". `fromModelNode` reads it into `openedAt`, which is what the files store already sorted Recent by and what `RecentPage` makes its day groups from |
| `listActivity` | `GET /api/files/activity?path=…` | ✅ | **added to the backend**: the events were all being recorded already, as bell entries with the file buried in `meta_json`. Two indexed columns make them findable per node. Readable by whoever may read the file (≥viewer). Keyed by path, so a rename splits a file's history across its two names — and there is no backfill, so history starts at the upgrade |
| `listVersions`, `restoreVersion` | `GET /api/files/versions?node_id`, `POST /api/files/versions/restore` | ✅ | both are guarded (≥viewer to list, ≥editor to restore — see the security row below), and the client now says what a row MEANS: filex snapshots the live bytes **before** a destructive write, so every row holds contents the file used to have and the live file has no row of its own. `Version.current` is gone — it marked the newest row, which labelled the previous contents as the present ones and withheld Restore from the one revision a rollback actually wants — so every row offers Restore, `restoreVersion` keeps sending `snapshot_current` (which is what makes a rollback itself undoable, and why the list grows by a row), and `mock/history.ts` models the same order rather than the opposite one |
| `listStarred`, `setStarred` | `GET /manager/star/list`, `POST /manager/star` per node | ✅ | loop per id |
| `listShared` | `GET /manager/shared-with-me` | ✅ | the page draws **Shared by** and **Shared on** and filled neither against a live server. **Both are on the wire now**: `shared_at` (the grant's `created_at`, epoch ms) always was, and `shared_by` / `shared_by_name` were added from the grant's `created_by` — the display name only, never the e-mail an account has instead of one. `HttpRepository.listShared` reads both off the grant rows and fills `sharedBy` / `sharedAt`; an account the server named no display name for gets the neutral `files.sharedByUnknown`, never an address |
| `listTrash` | `GET /manager/trash` paged, per storage, `ttl_days`, and `top_level_only=1` for one row per deletion | ✅ | **added to the backend**: the flat listing showed a deleted folder AND every file inside it, each offering a Restore only the folder's own restore performs. The app passes the flag. Both extra fields are read now: `fromTrashEntry` takes the kind off `type` (a deleted FOLDER used to arrive as a file, with an icon picked by extension and a byte count where a dash belongs) and carries `ttl_days` as `Node.ttlDays`, which the trash banner turns back into the install's retention — the days left plus the days already served — instead of the literal "30 days" it printed on every install. The move-to-trash confirmation in `DeleteModal.vue` names no term at all — nothing is in the trash yet at that point and no route states the policy to a non-admin, so it says "until it is deleted forever" rather than a number it cannot know. |
| `restore` | `POST /manager/restore {node_id}` | ✅ | loop per id |
| `deleteForever`, `emptyTrash` | `DELETE /manager/trash/{id}` and `POST /manager/trash/empty` | ✅ | **added to the backend**: the trash was a room the user could put things into and never take anything out of. Both are scoped to what the caller could have deleted (confinement + ≥editor on the original path); `empty` purges top-level rows in bounded rounds and reports `more`, which `HttpRepository.emptyTrash` loops on while it is still making progress |
| `createFolder`, `rename` | `POST /manager action=newfolder|rename` path-based, 409 on conflict | ✅ | **the 409 was added to the backend**: both verbs now Stat the target name first and refuse an occupied one, where `newfolder` used to `MkdirAll` over somebody else's folder and answer 200 and `rename` went straight to `os.Rename`, which on Linux silently replaces the file already sitting there. 409 becomes `DUPLICATE_NAME`, which is the error the modals already show |
| `moveToTrash`, `move` | the ops queue (`POST /api/files/move\|delete` + `GET /ops/{id}`) | ✅ | **the repository now uses the queue**, as copy already did. The synchronous `?q=move\|delete` held one request open for the whole subtree, which is what a proxy cuts at sixty seconds and reports as a failure for work that was going to succeed; a submit answers in milliseconds and each poll is its own short request. The queued delete is the identical soft delete (`trash.Put` + retag), so nothing about the trash changes. A job still running when the app stops waiting raises `OPERATION_PENDING`: the listing refreshes, the toast says it is still running, and no Undo is armed for half a move |
| `copy` | `POST /api/files/copy` + the ops queue; the handler refuses a copy whose source and target sit on different adapters | ⚠️ | cross-storage copy is out of scope for now (product decision): the destination picker keeps the other storages listed and greyed rather than pretending they are not there |
| `uploadFile` | the staged resumable path (`/upload/begin`, `PUT /upload/{id}`, `/commit`) | ⚠️ | **the repository uses the staged path**: 1 MiB chunks, real progress per accepted chunk, and the commit's op awaited so a finished row means the storage has the file. **Cancel and resume are wired**: a running row's ✕ aborts the transfer and `DELETE /upload/{id}` drops the staged bytes with their quota reservation; the session id is kept in `localStorage`, and at startup `GET /upload/{id}` says how far each unfinished one got so it comes back as a row offering Resume. ⚠ Resume asks for the file again and checks its name and size — a `File` does not survive a reload, and `POST /upload/begin` always opens a NEW session at offset 0, so the id is the only thread back. Folder upload rebuilds the tree with `createFolder` — one round trip per NEW folder, which is the floor, and no longer one listing of the parent per folder on top of it: the folder is created first and the collision is read as the answer. A level's folders go out together, so the cost is the tree's depth |
| `createShareLink`, `removeShareLink`, `shareLink` | `POST /share`; `GET /share?path=` (≥editor, and a non-admin is shown only their OWN links); `DELETE /share/{id}` | ⚠️ | the panel and the modal read the caller's live link when they open — before that they only ever knew about a link they had just minted, so a shared file reopened tomorrow said "Not shared" and offered to mint a second one. filex allows many links per node; the app shows the first and removes all of the caller's. `DELETE` takes the id the list calls `uuid` — reading `id` there sent `/share/undefined` and left the link open |
| `listSubfolders` (Move picker) | `GET /manager?q=subfolders&path=` | ✅ | the picker now expands a level at a time and asks for nothing else. Its filter box would then have searched only what somebody had opened, which is the same as not having one, so `POST /search` gained a `dirs_only` facet and the box asks the server instead — exact over the whole drive, without loading it |
| `listFolders` (settings' folder select) | same endpoint | ⚠️ | still the whole tree, because that select really does want every folder. The walk is now a LEVEL per round trip instead of a folder per round trip: a level's folders are independent, so they go out together and the cost is the tree's depth |
| `listRecent`/`listStarred`/`listTrash` with a `ListingFilter` | `?ext=&modified_after=&size_min=&size_max=&owner_id=` on each | ✅ | **added to the backend**: the chips used to be applied to the page rather than to the query, so past the ceiling (500 trash and starred, 200 recent) a chip narrowed a window and said nothing about it — "no images among your starred files" reads the same whether there are none or whether they all sit past number five hundred. The vocabulary is the advanced search's, word for word; the trash's date window tests `deleted_at`, because that is the date its "Modified" column shows |
| `listFolder` with a `ListingFilter` | folder listings take no filter | ✅ | still narrowed in the client, and exactly: `q=index` is not paged, so the client holds the whole folder |
| `listShared` with a `ListingFilter` | `shared-with-me` takes no facets | ⚠️ | still narrowed in the client. Its rows are not node rows — a grant can name a path the indexer never walked, and such a row has no size, date or owner for a query to test. The endpoint does build the whole set before paging it, so the app now asks for its maximum page (500) instead of the default hundred, and the chips are exact up to that many shared items |
| download of one file | `GET /manager?q=download&path=…` | ✅ | the address is `Repository.downloadUrl`, so the mock answers with its static asset and the HTTP repository with the manager's own download verb. It used to be one helper for both — the preview address plus `?download=1` — which is only true of the demo: against a live server that put a second `?` inside the query, the server read `?download=1` as part of the node's path, and the browser cancelled the save |
| download of a folder or a selection | `GET /api/files/download/zip?path=…&path=…`, streamed | ✅ | **added to the backend**: a zip built on the fly from any mix of files and folders. A GET, because the download has to be a navigation for the browser to own the save dialog and the disk write |
| `listFilterPeople` (People chip options) | derived from the `owner_id`/`owner_name` the listings now carry | ✅ | the chip offers exactly the people a filter over those rows could match. No endpoint on purpose: a `DISTINCT` over the node table would name owners of folders the caller cannot open |

## User settings modal

| What the modal writes | filex today | Status | Decision needed |
|---|---|---|---|
| profile: full name, display name, job title | `PATCH /api/auth/profile` takes `display_name`, `email`, `username`, `locale`, `timezone`, `avatar_url` and now `full_name`, `job_title` | ✅ | **added to the backend** (migration 00035): the two fields had no column, so the modal kept them in this browser's localStorage — a "profile" that did not follow the account to another machine. Both are optional: nullable, absent means "leave alone", an empty string clears |
| account email + role badge | `/api/auth/me` carries them | ✅ | mapped onto the app's `User`; filex's role names map onto the badge's three |
| avatar upload / removal | `avatar_url` on the profile PATCH — a small `data:image/…` URI, `""` removes it | ✅ | re-encoded to a 160px square at quality 0.85 before it is sent, centre-cropped rather than squashed; the avatar rides inside every presence frame, so the size is not cosmetic |
| password, 2FA | `POST /api/auth/password`; TOTP under `/api/auth/totp/*` | ✅ | **the password change is wired**, gated on the realm's `change_password`. 2FA is deliberately NOT rebuilt here: the second factor belongs to the auth provider, and the app only reports its state |
| active sessions | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}` | ✅ | **added to the backend**: filex had recorded a row per sign-in since its first migration and never showed it to the person who made it. The row now carries the count, opens in place into the list, and ends one sign-in at a time; the session the app is calling with is marked and cannot be ended (that is what signing out is). `ip` and `user_agent` were also never WRITTEN — both login drivers passed empty strings — so they are filled from now on and older rows read "Unknown device" |
| notification switches | `GET/PATCH /api/notifications/settings` | ✅ | **the endpoint existed and nothing read it**: `notify.Send` inserted every row whatever the user had muted, so wiring the switches to it alone would have drawn a working-looking control over a preference no code consulted. The send path honours the matrix now. The three switches map onto `share.created`, `comment.added` and `file.uploaded`; `file.upload_failed` is deliberately NOT part of "finished uploads", and the app rewrites only those three keys so an event set elsewhere survives |
| theme, language, compact list, time zone, upload prefs | none | ✅ | client-only on purpose (localStorage `filex.app.settings`); revisit only if prefs must follow the user across devices |
| assistant enable + default mode | `assistant.enabled` is the OPERATOR's switch (`PUT /api/admin/assistant/provider`), seeded once from `FILEX_ASSISTANT_ENABLED` | ⚠️ | the enable switch is the administrator's, not the user's: it decides whether the installation talks to a model provider at all, and the panel is drawn from `GET /api/assistant/status`. The mode chips are sent now (`mode` on the turn): the server turns the chip into one sentence of scope guidance for that turn, not stored and not replayed. The admin PAGE is built: *Admin → AI assistant* (`web/src/views/Assistant.vue`) — provider, base URL, model, the per-account rate limit and a write-only key, a Test button that makes one real call, and the conversation list as metadata with a delete button and no way to read one |

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
| `owner_name` on the listings that are NOT folder listings | the fix above reached only `q=index`. Starred, recently opened and search answer with `model.Node` rows, which carry `owner_id` but had no name to print — so the client threw the id away and stamped the caller onto every row, and three of the five listings went on saying "You" over other people's files. `attachOwnerNames` now stamps the name on those three, the same one query per page, and the client keeps whatever filex named. A row with no owner (what a sync found, not what a person uploaded) still falls back to the caller, because everything they can see, they can see |
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
| — (client-side) the listing table has a minimum width and scrolls | not a backend row, but the same class of defect: below roughly 1200px the name column was the only flexible one, so it absorbed every lost pixel and vanished — at 1100 the "Name" and "Owner" headings printed on top of each other and the right-hand columns were cut off with nothing to scroll. Measured, not guessed. The table now stops at `63 + 60 + 200 + Σ(column widths)` and its own container scrolls horizontally; the 1672 the design is drawn for is wider than that in every state, assistant panel included, so no reference pixel moved |
| a fully quoted query is a phrase search inside files | the advanced form's "whole phrase" box had nothing behind it: the app never sent it and the content side ran an AND match, which finds a document that says "annual" in one paragraph and "report" in another. A quoted query now becomes a Bleve `match_phrase` — no index change, because the default text mapping already records term positions (measured before writing it). Deliberately content-only: `PrepareQuery` strips quotes before the NAME side sees them, and it must, since filename matching is subsequence matching by design (`invoice 2026` → `invoice_2026.pdf`, issue #15) |
| reading `GET /api/files/permissions` needs viewer, not owner | "who else can see this file" is a question anybody who can open the file may ask, and it was answered only to owners — so a shared folder's access panel showed a non-owner nothing but their own row. The mutating verbs keep the owner bar, and the answer says `can_manage` so the client renders a list instead of controls that would 403. Below viewer it is still refused: naming people to somebody who cannot open the file is a leak of its own |
| `used_bytes` per drive on `GET /api/files/storages` | the drive cards drew their figure from `/quota/me`, which meters the ACCOUNT — so two drives showed one number twice, each labelled as that drive's. One grouped SUM over the node table answers per drive; the ceiling stays the account's, because that is the only ceiling filex has. Trashed files count (the bytes are still on the driver), directory rows do not (they carry an aggregate of their subtree) |
| `thumb` on the starred, recently-opened and search rows | the folder listing carried `thumb_url` and the app never read it: every tile loaded the ORIGINAL through `assetUrl`, so a grid of 200 photos was a gigabyte and a video tile a media fetch per card. The tiles now paint `thumbUrl` — the pipeline's cached 320px JPEG, versioned by mtime because the server caches it a day under the node id alone — and fall back to placeholder art, never to the original. The three `model.Node` listings had no thumbnail state at all, so `attachThumbs` stamps it there the way `attachOwnerNames` stamps the owner; the client builds the address from the node id when the state is `ready`. Trash rows are their own projection and stay without one. Two more things the first live run showed: a file the storage SYNC catalogues never reached the pipeline at all (only writes through filex did; the docs said "run `thumb backfill`"), so the walk now queues a `thumb` op per new or drifted file on the ops queue, rendered by the bounded pool; and an image under 500 KB is not rendered at all (`thumb.SmallImageBytes`) — the client shows the file itself as its tile, because a 320px JPEG next to a 100 KB original saves nothing |
| an ACL gate on `/api/files/versions` (`guardedNode`) | the three version routes took a NODE ID and asserted nothing on it, so any signed-in account could read another person's file history and restore an older revision over their live bytes by guessing an integer. ≥viewer to list a timeline, ≥editor to snapshot or restore, plus the tenant-root confinement every other route applies; an unknown id now answers 404 rather than an empty timeline, which was itself an answer about whether that id is a file |
| `node_versions.created_by` (migration 00036) | the versions panel named the person LOOKING at it as the author of every revision, including ones somebody else wrote — the client had no author to show and filled the column with the current user. Recorded from the request's principal at snapshot time; a background snapshot has no principal and records none. No backfill, so older revisions show a date and a size and no name |
| `created_at`, `item_count` and `shared` on listing rows | three columns the app drew from nothing. The creation date was in `model.Node` all along and the listing projection simply did not carry it. The item count did not exist: a folder showed the word "Folder" where the design shows "12 items", and counting client-side is impossible — the listing holds the folder, not its contents. `shared` was hard-coded `false` on every row, so the folder badge that says "this is reachable by link" never lit and the only way to find out was to open the share modal file by file. Two grouped queries per page (`ChildCounts`, `SharedNodeIDs`), the shape `attachOwners` already established, not a query per row |
| `GET /api/files/manager/trash?top_level_only=1` | the trash listing is flat by construction: a deleted folder drags its cached descendants in as rows of their own, so the user saw the folder and every file inside it, each offering a Restore only the folder's own restore performs. Collapsing them client-side would mean guessing parentage from path prefixes; the server knows it. Opt-in, so the admin trash screen and the purge scan still see every row |

### Still applied client-side

| Question | What exists | Consequence |
|---|---|---|
| Filters on the folder listing and on shared-with-me | those two endpoints take no facets, for the reasons in the table above | `HttpRepository` narrows them through `data/listingFilter.ts`, the same predicate the mock uses. Exact in both cases — one is unpaged, the other is asked for its whole page |
| A date window on a node whose `backend_mtime` is null | SQL compares that column; the client falls back to `db_mtime` and then `updated_at` | such a row is now dropped by a Modified chip where it used to be kept. It is the behaviour the advanced search has always had, and the alternative — three columns coalesced in every listing query — buys a row that no listing dates anyway |
| Advanced search facets | `q`, `scope`, `limit`, the seven facet fields, and a quoted query for the phrase box | what remains here is the hand-typed size range and the free-text path prefix. The `«»` match markers the server wraps each hit in are now split into highlight ranges by `fromSnippet` — the search page used to print the guillemets as though they were part of the file |
| A visible row past the trash page's window | confinement and RBAC are a tenant root and a set of path-prefix grants, neither of which is a column | both run over the page the query returned, so a page whose rows are mostly invisible comes back short instead of reaching further down. `total` no longer collapses to the page size, but on a paged listing it is an upper bound: rows dropped from pages nobody asked for are not known. Closing this needs the grants inside the query |
| Item count per folder on an RBAC storage | one grouped query cannot apply `CanSee` per child | counted for admins and RBAC-off storages; a caller holding grants gets no count at all, because a traversal folder would otherwise advertise entries opening it does not show |
| Modification date of a folder ROOT | a storage root is not a node and has none | `Node.modifiedAt` is optional too; the formatters render an em dash. Anything filex did date keeps its date |
| The link BEHIND a shared row | `GET /share` is per node and refuses below editor | the row says THAT a node is shared; the URL is a credential, so the details panel and the share modal ask for it per node when they open. filex lists a non-admin only the links they minted, so somebody else's link reads as "none of yours" |

### No endpoint at all

| Repository method | State |
|---|---|
| version authorship | recorded from migration 00036 on. Revisions taken before it have no author and are shown without a name — there is no backfill, because nobody wrote one down |

## Capability snapshot

`GET /api/files/capabilities` reports what the storage DRIVERS can do, and the
app maps those field for field: `upload`, `move`, `copy`, `delete`, `mkdir`,
`search`, `versions`. (`ocr` is reported too and no longer read — OCR happens at
extraction time, so there is no OCR surface for a flag to gate.) Five more are
the app's own axes and filex does not report them, so
`HttpRepository.capabilities` decides them from whether an endpoint exists at
all: `tags`, `permissions`, `folderDownload`, `activity` and `deleteForever` on.
`assistant` is the exception and is now ASKED (`GET /api/assistant/status`,
fetched alongside the driver snapshot): it is the one axis that really varies —
an installation with no provider configured has no assistant — and a server too
old to answer that route is read as "no assistant" rather than as a failure.

Reporting them from the server was considered and **deliberately not done**: in
a build where those routes are compiled in, every one of them can only be
`true`, so the server would be sending a constant for the client to read instead
of assuming — the assumption moves, it does not go away. The one axis that will
genuinely vary is `assistant`, and its flag belongs with the endpoint that makes
it vary — which is where it now lives.

| Repository method | filex today | Status | Decision needed |
|---|---|---|---|
| `capabilities` | `GET /api/files/capabilities` | ✅ | the driver axes come from the server; the app-level ones are decided by the HTTP repository from the fact that their endpoints exist (see above for why that is not a gap) |
| `setTags`, `listTags` | `POST /api/files/manager/tags {node_id, tags}` replaces the list; `GET …/tags?node_id` reads it | ✅ | the read was missing entirely: no listing carries tags, so the modal opened EMPTY on a file that had them — and since the modal writes the whole list, saving from there erased what was there. It reads the node's tags when it opens, which also means it shows what the server actually stored (lower-cased, nothing over 64 chars) rather than what was typed |

## Model gaps

- **Owner**: nodes DO have one — `nodes.owner_id`, written by quota accounting
  on every upload and save since migration 00004. The earlier claim here that
  there was none was wrong. The listing projection now carries `owner_id` and
  `owner_name`, so a shared drive shows who put each file there instead of "You"
  for everything. What is still missing is the GROUP owner the product decision
  asks for on shared drives; a node a storage SYNC found has no owner at all and
  falls back to the caller, which is the honest reading of "everything you can
  see, you can see".
- **The group owner is the DRIVE.** filex has no group entity — no table, no
  membership, nothing in the ACL (`Provider.AdminGroup` is an OIDC claim name
  and nothing more) — and the decision that asked for one was about the Owner
  column. So on a drive the caller reaches through GRANTS rather than through
  their role, the column names the drive instead of a person. `GET
  /api/files/storages` carries `shared` per drive, derived from the test
  `shared-with-me` already makes: grants are loaded only for a non-admin on an
  RBAC-enabled storage, so holding any is exactly the condition. No migration,
  no new entity, and nothing in the ACL moved.
- **Capabilities**: the UI reads `GET /capabilities` and hides what the server
  cannot serve. OCR is not among them: it is an extraction-time property (text
  found in an image is content like any other), so there is no OCR surface for a
  flag to hide.

## Still open on the server

Carried over from the 2026-09-09 review when its working notes were removed; the
numbering is that review's.

- **N-20 — upload conflicts are decided on the client.** The server can only
  overwrite, taking a version snapshot as it goes. "Skip", "keep both" and "ask"
  are implemented in `app/` before the bytes are sent, so two clients uploading
  the same name still race, and a non-filex client gets the overwrite. Server
  support is its own task.
- **N-21 — the assistant's failures reach the store as a transport error.**
  `assistantStore` reads the error CLASS because it needs the HTTP status and
  the `code` from the body, which the repository contract does not carry. The
  honest fix adds assistant-failure sentinels to the contract and translates
  inside the two methods — a change to a public contract, deliberately deferred
  rather than papered over.
