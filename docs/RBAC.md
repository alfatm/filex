# filex — RBAC & per-file/folder permissions (API + MCP reference)

Added in v0.1.41+ (backend `internal/acl`). This documents the access model and
every endpoint / MCP tool the feature exposes. Backwards compatible: RBAC is
**off per storage by default**, so an untouched deployment behaves exactly as
before.

## Model

Two layers combine, then a ceiling is applied:

1. **Account role** (`users.role`): `admin` (full panel, exempt from all ACL),
   `user` (explorer only; read+write; can hold owner grants), `viewer`
   (explorer only; read-only — view/download, no edit/convert/mutate).

   "Explorer only" is a URL as well as a permission: give a `user` or `viewer`
   account the address `…/drive` and they land in the file manager — their
   storages, uploads, sharing, search and the editor — with no admin chrome and
   nothing extra to deploy. `…/admin` is the same application served under the
   operator's prefix; a non-admin who follows an old `/admin/...` link is
   handed on to `/drive/explore` (and the backend re-checks the role on every
   `/api/admin/*` call regardless of which URL asked).
2. **Per-storage RBAC toggle** (`storages.rbac_enabled`, default `false`):
   - OFF → storage visible to every authenticated user; capability = account
     role (user→editor, viewer→viewer, admin→owner). No grants needed.
   - ON → storage hidden; a non-admin sees only paths granted to them (directly
     or inherited from a parent folder).
3. **Item grant level** (`file_grants`): `viewer` < `editor` < `owner`.
   - Inheritance: a folder grant cascades to descendants. Effective level =
     highest covering grant (direct or inherited), then **capped by the account
     role** (a viewer account stays viewer even if granted higher).
   - Only an `owner` of an item (or an admin) may see/manage its permissions.
4. **Group grant** (`file_group_grants`) — the same triple addressed to a
   **group** instead of an account. See *Groups* below. User grants and group
   grants are merged into one set, never ranked: the effective level is the
   highest covering grant from either source, and the role ceiling still caps
   the result.

Enforcement is server-side at every `/api/files/*` chokepoint AND the `/api/ai`
(REST + MCP) surface, keyed off the authenticated user — so cookie sessions are
filtered too, not just tokens. `internal/confine` (the token `root:` scope hard
ceiling) still composes on top.

## Groups

Added with migration `00043`. A **group** is a named set of accounts. Granting a
path to a group grants it to whoever is in the group *at the moment access is
checked* — take somebody out of the group and their access goes with them, with
no grant row to hunt down.

Three tables:

| Table | Shape |
|-------|-------|
| `groups` | `id, name, description, provider_id, created_by, created_at, updated_at`, UNIQUE(`provider_id`, `name`) |
| `group_members` | `group_id, user_id, added_at`, PK(`group_id`, `user_id`) |
| `file_group_grants` | `id, storage_id, path_prefix, is_dir, group_id, level, created_by, created_at`, UNIQUE(`storage_id`, `path_prefix`, `group_id`) |

`file_group_grants` is a separate table rather than a nullable
`file_grants.user_id` because SQLite cannot drop a `NOT NULL` constraint without
rebuilding the table, and rebuilding the live ACL table is not worth one fewer
join. `groups` is backtick-quoted in the SQLite/MySQL SQL — it is a reserved
word in MySQL 8.

**Tenancy** works exactly as it does for users: a group is homed in the caller's
provider, a tenant admin never lists or reaches another tenant's groups, and an
out-of-tenant group id answers 404 rather than 403.

**How they merge.** `acl.Resolver.LoadSet` loads the caller's own grants *and*
the grants held by every group they are in (`ListGroupsOfUser` →
`ListFileGroupGrantsByStorageGroups`) into one `Set`. `Effective`, `CanSee`,
`StorageVisible` and `Grants()` therefore see both without knowing the
difference; each row carries `principal` (`"user"` / `"group"`) plus the group
id and name for reporting, and `Set.ViaGroups()` names the groups a caller
reaches a storage through.

**Where groups surface.** `GET /api/files/storages` gives every drive a
`"via_groups": ["Design", …]` — the groups through which the caller holds any
grant on it, always an array and empty when access is entirely personal
(`shared` is unchanged and still means "reached by grant, not by role").
`shared-with-me` rows carry `via_group`; the permissions panel and the admin
overview carry `principal`.

## Endpoints — permissions panel (`/api/files/permissions`)

Mounted in the authenticated group. Every write requires the caller to be admin
**or** hold `owner` on the target path.

| Method | Path | Body / query | Notes |
|--------|------|--------------|-------|
| GET | `/api/files/permissions?path=<adapter>://<rel>` | — | `{direct[], inherited[], storage_rbac, effective, can_manage}`. Viewer+ to read. Every row carries `principal`: a `"user"` row has `user_id`/`user_email`/`user_display_name`, a `"group"` row has `group_id`/`group_name`/`member_count` and no `user_*` fields. |
| POST | `/api/files/permissions` | `{path, user_id \| group_id, level, is_dir?}` | Upsert a grant. `group_id` creates a `file_group_grant` (404 for an unknown or out-of-tenant group); `group_id` wins if both are sent. 409 if storage RBAC off; 400 if granting a viewer **account** >viewer. |
| PATCH | `/api/files/permissions/{id}?principal=group` | `{level}` | Change a grant's level. Without `?principal=group` the id addresses `file_grants` — the two tables have independent id spaces. |
| DELETE | `/api/files/permissions/{id}?principal=group` | — | Revoke. Same disambiguation. |
| GET | `/api/files/permissions/resolve?email=` | — | `{found, user?}` — existing account or not. |
| GET | `/api/files/permissions/users?q=` | — | `{users[]}` autocomplete of existing accounts. |
| GET | `/api/files/permissions/groups?q=&limit=` | — | `{groups:[{id, name, member_count}]}` for the picker. Any authenticated non-viewer caller; tenant-scoped. |
| POST | `/api/files/permissions/invite` | `{path, email \| group_id, level, create_user?, role?}` | `group_id` → a group grant, `{mode:"granted", group_id, group_name}` (no mail, no share-link fallback; 404 unknown group). Otherwise: existing account → grant (`mode:"granted"`); admin+`create_user` → new account+grant (`mode:"user_created"`, temp password); else public share link (`mode:"shared"`, with `url` and `note:"no account with that email; a public link was created instead"`). Every response carries `mode`. Mail is sent only when SMTP is verified, else the link/password comes back for on-screen display. |

## Endpoint — "shared with me" (`/api/files/manager/shared-with-me`)

The permissions panel answers "who can see *this* folder". The reverse question
— "what has been shared with *me*" — has its own endpoint, and it is what the
explorer's navigation panel lists under **Shared with me**.

| Method | Path | Query | Notes |
|--------|------|-------|-------|
| GET | `/api/files/manager/shared-with-me` | `limit` (100, max 500), `offset` | `{files[], storages[], total, limit, offset}`. Any authenticated caller; no admin or owner requirement — you are asking about your own grants. |

Three rules decide what is in it:

- **Grants only.** A storage with RBAC **off** is reached by every authenticated
  account through their role, so a grant row there is inert and its files are
  the caller's own, not "shared with them". Only RBAC-enabled storages are
  consulted.
- **The item, not its contents.** A grant on a folder lists the folder.
- **A whole-storage grant is a drive, not an item.** It has no name to render,
  so it is reported in `storages[]` — the shared drives the UI marks in its
  storage list — instead of as a file row.
- **Group grants count.** An item reached through a group is listed too, with
  `"via_group": "<name>"` on the row. One row per item, not per grant: when both
  a personal and a group grant cover the same path, the higher level wins and
  only that row is kept (so a personal grant that outranks the group's drops the
  `via_group` marker).

Tenant scope is applied explicitly here, not inherited: `tenantstore` wraps only
the storage/user *listing* methods, so a per-grant read like this one has to gate
itself or it hands one tenant the paths of another's shared folders.

## Endpoints — self-service tokens (`/api/tokens`)

Any authenticated user (incl. non-admin) mints tokens **bound to themselves**,
capped server-side:

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/tokens` | The caller's own tokens (no secrets). |
| POST | `/api/tokens` | `{label, scopes, expires_in_days?}`. Always minted as `kind: "user"`. Verb-scope ceiling: viewer→`read`/`mcp` only; user→`read,write,delete,mcp`; **never `admin`**. Empty scopes are never stored (would be "all"→escalation). A `root:<adapter>://<rel>` scope must be ⊆ the caller's own grants. Plaintext returned once. |
| PATCH | `/api/tokens/{id}` | Ownership-checked; label / usernames only. `kind` is admin-only. |
| DELETE | `/api/tokens/{id}` | Ownership-checked. |

⚠ **This surface — and the other three self-service credential surfaces,
`/api/auth/s3-keys`, `/api/auth/ssh-keys`, `/api/auth/nfs-exports` — answer 403
to an `app` token** (`reason: "app_token"`, from one shared middleware,
`handlers.RequirePersonalCaller`). A token acts AS its owner, so a shared
integration token — the one a host app's proxy injects in front of many
visitors — would otherwise let any of them list and revoke the credential that
embed runs on, or mint a new S3 key bound to its owner. Cookie/OIDC sessions
and `user` tokens are unaffected. See [MCP.md → Token kinds](MCP.md#token-kinds--user-vs-app);
the escape hatch for a personal token that migration `00030` defaulted to `app`
is `PATCH /api/admin/ai-tokens/{id}` `{"kind":"user"}`.

⚠ Kind is a **different axis from role and from confinement**. It does not widen
or narrow what a caller may do — every check on this page still applies — it only
decides whether the surfaces that belong to one identity are drawn at all.

## Operation permissions (per role)

Added in v0.6+ (backend `internal/perm`, migration `00044`). A **third**,
coarser gate that sits *beside* the two layers above, never instead of them.

- The item grant answers *"may this person touch THIS file"*.
- The operation permission answers *"is this person's role allowed to do this
  KIND of thing at all"*.

Both must say yes. Taking `files.purge` away from the `user` role changes no
grant: every editor grant still reads and writes exactly as before, and the
"Delete forever" button simply stops working for that role, installation-wide.
Admins carry `*` and skip the check entirely.

The vocabulary lives in the code (`perm.Catalogue`), not in the database:
`roles.permissions_json` stores only which of these an installation switched on,
so a row naming an operation no handler checks can never exist.

### Catalogue

| Operation | Group | Covers |
|-----------|-------|--------|
| `files.upload` | write | staged upload `begin`, the multipart upload verb, legacy presigned `upload/init`, "new file", the text editor's save, ShareX + AI uploads, **archive extract + archive add**, **AI `zip` / `unzip`** |
| `files.mkdir` | write | new folder (`?action=newfolder`, AI `mkdir`) |
| `files.rename` | organise | rename in place |
| `files.move` | organise | move (`?action=move`, `POST /api/files/move`, ops `move`, AI `move`) |
| `files.copy` | organise | copy (`POST /api/files/copy`, ops `copy`) |
| `files.delete` | organise | send to trash (`?action=delete`, `POST /api/files/delete`, AI `delete`) |
| `files.purge` | organise | delete forever + empty trash (assistant `plan_empty_trash` too) |
| `files.restore` | organise | restore from trash **and** restore an older version (assistant `plan_restore_version` too) |
| `files.tags` | organise | writing a node's tags (reading them is not gated) |
| `files.download` | read | `?q=download`, `GET /api/files/read?download=1`, AI `download`, the zip endpoint. **Not** preview, `GET /api/files/read` without the flag, or thumbnails |
| `files.star` | read | setting the starred flag |
| `files.share` | share | minting a public link (+ share-mail) |
| `files.grant` | share | the permissions panel: create/update/delete a grant, invite |

`files.download` is deliberately separate from viewing. A role that may open a
document in the browser but not take a copy away is a real configuration;
gating preview as well would make "no downloads" mean "no reading".

`files.delete` and `files.purge` are likewise separate: an install can let a
role move things to the trash while reserving the irrecoverable step.

### Where it is enforced

Every door onto an operation is gated, not the obvious one. The list is worth
reading in full, because an ungated second door is what makes a permissions
screen lie:

- **Uploads / new bytes** — staged `upload/begin`, the multipart upload verb,
  `?action=upload`, `?action=newfile`, `POST /api/files/save-text`,
  `POST /api/files/upload/init`, ShareX, `POST /api/ai/upload`,
  `POST /api/files/archive/extract`, `POST /api/files/archive/add`,
  `POST /api/ai/zip`, `POST /api/ai/unzip`.
- **Folders** — `?action=newfolder`, `POST /api/ai/mkdir`, the ops queue's
  `mkdir`. Archive extraction and unzip need `files.upload` only: the folders
  they create hold the members being written, so requiring `files.mkdir` as
  well would mean taking folder-creation away from a role had silently
  switched off unpacking a zip.
- **Organise** — the `Mutate` verbs (rename / move / delete), the async
  per-verb endpoints and the generic `/api/files/ops` submit (both doors onto
  one queue), `POST /api/ai/move`, `POST /api/ai/delete`, trash purge / empty /
  restore, version restore.
- **Taking bytes away** — `?q=download`, `GET /api/files/download/zip`,
  `GET /api/ai/download`, and `GET /api/files/read?download=1`.
- **Sharing and access** — `POST /api/files/share`, share-mail, AI `share`,
  the grants CRUD and invite.
- **Per-user metadata** — tags, star.
- **The assistant's approved plans** — an approved plan is executed by the
  server, which makes it a second door onto the buttons above. The plan kind is
  mapped to its operation and checked before the first item runs:
  `tags`→`files.tags`, `restore_version`→`files.restore`,
  `create_share`→`files.share`, `empty_trash`→`files.purge`,
  `move`→`files.move`. A refusal is reported as the assistant refusing — the
  card comes back with every line `skipped` / `forbidden` — not as a 403 over
  the whole request and not as a 500. `revoke_share` is not gated: closing a
  link is not minting one, and no other revoke surface is gated either.

### ⚠ The two deliberate holes

1. **Inline viewing is never gated.** `?q=preview`,
   `GET /api/files/read` without `download=1`, and thumbnails are open to
   anyone the item grants let see the file — no operation permission is
   consulted. `files.download` means *may not take a copy away*, not *may not
   read*. Anyone who can view a file can of course still capture its bytes
   from the browser; the permission is a policy about the product's affordances,
   not a DRM claim.
2. **The protocol gateways are not gated at all** — see the limitation below.

### Defaults

| Role | Operations | Editable |
|------|-----------|----------|
| `admin` | `*` (reported expanded as the whole catalogue) | no |
| `user` | every operation | yes |
| `viewer` | `files.download`, `files.star` | yes |

These are **not** a behaviour change on upgrade. `user` receives everything it
could already do; `viewer` receives what the viewer ceiling already allowed
(every mutation was refused by `acl.RoleCeiling` before this existed). Migration
`00044` rewrites the legacy, never-read vocabulary into the new one:

```
files.read   -> files.download, files.star
files.write  -> files.upload, files.mkdir, files.rename, files.move,
                files.copy, files.tags, files.restore
files.delete -> files.delete, files.purge
files.share  -> files.share, files.grant
*            -> unchanged (admin)
```

### The refusal

A blocked request answers **403**:

```json
{"error":"your role may not do this","code":"ROLE_FORBIDDEN","op":"files.upload"}
```

`code` exists so a client can say "your role may not delete files" instead of
the generic "forbidden" it shows for an ACL denial — the two are different
problems with different fixes and must not look alike in a support thread.

An API token acts AS its owner, so the `/api/ai/*` and `/api/sharex/*` surfaces
answer to the same role gate as the browser. The credential-free public surfaces
(share link, file-drop, upload ticket) have no role to consult and are governed
by their own token, exactly as before.

### ⚠ Limitation — protocol gateways

The gate is wired on the **HTTP API only**. WebDAV, SFTP, FTPS, NFS and the S3
gateway (`internal/dav`, `internal/sftpsrv`, `internal/ftpsrv`, `internal/nfssrv`,
`internal/s3api`) do **not** consult `internal/perm` in this release: they keep
enforcing the account role + item grants as they always have. An account whose
role has lost `files.delete` can still delete over SFTP. Treat operation
permissions as a UI/API policy until the gateways are wired.

### Endpoints — admin

| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/api/admin/roles` | — | `{"roles":[{"name","permissions","editable"}],"catalogue":[{"id","group"}]}`. Permissions are expanded — `admin` comes back as the full catalogue, never as `["*"]`. |
| PUT | `/api/admin/roles/{name}` | `{"permissions":["files.upload",…]}` | 200 → the role row. 400 for `admin` (not editable), an unknown role, or an operation outside the catalogue. Audited as `role.permissions`. |

`GET /api/files/capabilities` additionally carries `"permissions": [...]` — the
**caller's** expanded set (admin → the whole catalogue; anonymous → `[]`), so the
explorer can hide affordances the server would refuse.

## Endpoints — admin (`/api/admin`, admin-only)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/admin/grants` | Global overview: every grant — user and group alike — enriched with `storage_name`, plus `principal` and `user_email` / `group_id` + `group_name`. |
| POST | `/api/admin/grants` | `{storage_id, path (rel, `""` = root), is_dir?, level, user_id \| group_id}` → 201 with the row. 409 if that principal already has a grant on that path (PATCH is for relevelling), 400 when RBAC is off on the storage ("enable RBAC on this storage first") or when granting a viewer account >viewer. |
| PATCH | `/api/admin/grants/{id}?principal=group` | `{level}` — admin override relevel. |
| DELETE | `/api/admin/grants/{id}?principal=group` | Admin override revoke. |
| GET | `/api/admin/groups` | `?q=&limit=&offset=` → `{groups:[{id, name, description, member_count, created_at}], total, limit, offset}`. |
| POST | `/api/admin/groups` | `{name, description?}` → 201 group. 409 on a duplicate name within the tenant. |
| GET | `/api/admin/groups/{id}` | Group + `members:[{id, email, display_name, role}]`. |
| PATCH | `/api/admin/groups/{id}` | `{name?, description?}`. |
| DELETE | `/api/admin/groups/{id}` | Cascades: membership and every grant addressed to the group go with it. |
| PUT | `/api/admin/groups/{id}/members` | `{user_ids:[…]}` — replaces the membership. Every id is validated first; an account from another tenant is a 400. |
| POST | `/api/admin/groups/{id}/members` | `{user_id}` — idempotent. |
| DELETE | `/api/admin/groups/{id}/members/{userId}` | Removes one member, and with them every access they only had through the group. |
| POST | `/api/admin/settings/smtp-test` | `{to?}` → `{ok, error?, sent?}`. Verifies the SMTP config (auth handshake) and, with `to`, sends a real test mail. SMTP config lives in the `smtp.*` settings keys (`host/port/tls/from/username/password`). |

`storages.rbac_enabled` is set via the normal storage create/update payloads
(`POST/PATCH /api/admin/storages`, field `rbac_enabled`).

## MCP admin tools

Exposed on `/api/ai/mcp` for an API token carrying the `admin` scope (alongside
the existing 59 `admin_*` tools):

| Tool | Input | Effect |
|------|-------|--------|
| `admin_grants_list` | — | List every grant (who/where/level). |
| `admin_grant_set` | `{body:{path, user_id \| group_id, level, is_dir?}}` | Grant/upsert, for an account or a group. Storage must have RBAC on; viewer accounts capped to viewer. |
| `admin_grant_revoke` | `{id}` | Revoke a **user** grant by id. Revoking a group grant needs `?principal=group`, which this tool's input shape cannot carry — use the HTTP API. |

The AI file surface (`file_*` tools + `/api/ai/files|read|upload|...`) is already
gated by the bound user's grants + role ceiling via `aiOps` — a confined,
non-admin token only sees/mutates what its user was granted.

## Tests

`backend/internal/acl/acl_test.go` (resolution: Effective/CanSee/ceiling/prefix),
`backend/internal/api/handlers/tokens_self_test.go` (scope-ceiling / escalation),
`backend/internal/api/handlers/grants_test.go` (end-to-end: owner grant, viewer
ceiling, owner-only panel, self-token limits, admin overview, non-admin 403),
`backend/internal/acl/group_test.go` (group grants merged, higher level wins,
role ceiling, membership removal),
`backend/internal/db/drivers/sqlite/groups_test.go` (membership replace,
`ListGroupsOfUser`, delete cascade, ancestor prefixes),
`backend/internal/api/handlers/groups_test.go` (admin group CRUD + members,
group grant visibility, panel principals, `?principal=group`, invite by group,
admin grant POST/PATCH, shared-with-me `via_group`, drive `via_groups`),
`backend/internal/perm/perm_test.go` (catalogue/defaults vs migration 00044,
admin wildcard, set/validate/invalidate),
`backend/internal/api/handlers/role_perm_test.go` (end-to-end: every operation
refused through its real route, the neighbouring operation still allowed,
viewer defaults unchanged, the admin endpoints, capabilities).
