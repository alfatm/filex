# Quotas — what counts, and when

Quota is **per user**, and there are **three** ceilings:

| Ceiling | Column | Counter | What it protects |
|---|---|---|---|
| **Storage bytes** | `users.quota_bytes` | `users.usage_bytes` | disk |
| **File count** | `users.quota_files` | `users.usage_files` | listings, scans, backups |
| **Upload rate** | `users.quota_upload_bytes` | `upload_ledger` within a window | transfer, egress bills |

The admin surfaces are `GET|PATCH /api/admin/quotas` (the instance defaults),
`GET /api/admin/quotas/users` (the table) and
`GET|PATCH /api/admin/users/{id}/quota` (one user's overrides); the caller's own
snapshot is `GET /api/files/quota/me` — see
[Backend → Admin: quota](BACKEND.md#admin-quota).

This page is about the other half: **how the counters get their values**, which
is the part that has to be exactly right or the ceilings are decoration.

## Defaults and overrides — the tri-state

Every per-user limit column is an **override**, not a value:

| Stored | Meaning |
|---|---|
| `0` | inherit the instance default |
| `-1` | **unlimited** for this user, whatever the default says |
| `N` | this user's own limit |

The instance defaults are `settings` rows, editable at runtime:

| Setting | Env seed (first boot only) | Default | Range |
|---|---|---|---|
| `quota.default_bytes` | `FILEX_QUOTA_DEFAULT_BYTES` | `0` (unlimited) | ≥ 0 |
| `quota.default_files` | `FILEX_QUOTA_DEFAULT_FILES` | `0` (unlimited) | ≥ 0 |
| `quota.default_upload_bytes` | `FILEX_QUOTA_DEFAULT_UPLOAD_BYTES` | `0` (unlimited) | ≥ 0 |
| `quota.upload_window_hours` | `FILEX_QUOTA_UPLOAD_WINDOW_HOURS` | `24` | 1 – 720 |

> ⚠ The environment variables are **seeds**, not overrides. They are consumed
> once, on a boot where no row exists yet; after that the row wins and editing
> the variable in compose changes nothing. See `internal/dbsetting`.

Resolution happens in exactly one function (`quota.Service.Limits`) and produces
a struct in which **0 means unlimited** and nothing downstream re-reads a
tri-state. `/api/files/quota/me` and the admin table report a `sources` block
(`"default"` or `"user"`) so an admin can see whether clearing an override would
change the number.

### What migration 00042 had to rewrite

`users.quota_bytes = 0` meant **unlimited** before this tri-state existed, and
it now means *inherit*. Those are the same thing only while the default is still
unlimited, so leaving the rows alone would have been a trap: an admin who sets
`quota.default_bytes = 10 GB` for new accounts would retroactively cap every
account that had deliberately been given no limit, with nothing in the data to
tell "explicitly unlimited" from "never configured".

So the migration writes `-1` wherever the column read `0`, and the old meaning
survives explicitly. `quota_files` and `quota_upload_bytes` are new columns, so
`0` is the right starting value for them.

> ⚠ **For existing API clients:** `POST`/`PATCH /api/admin/users/{id}/quota`
> with `{"quota_bytes": 0}` used to mean "make this account unlimited" and now
> means "inherit the instance default". Send `-1` for unlimited. Nothing else
> about that endpoint changed.

## The rule

One identity holds the whole design together:

```
usage_bytes(u) == SUM(nodes.size) WHERE owner_id = u AND type = 'file'
                  — trashed rows INCLUDED
```

and, since v0.21, its twin:

```
usage_files(u) == COUNT(*) WHERE owner_id = u AND type = 'file'
                  — the same rows, counted instead of summed
```

`nodes.owner_id` is stamped when the bytes land, and everything else follows
from these identities. The file count moves wherever the bytes move: a create
adds one, a purge releases one, an overwrite by another user moves one, trash
and restore and rename move none.

| Event | What happens to usage | Why |
|---|---|---|
| **Bytes land** (any write path) | owner stamped, size added | the account now stores them |
| **Overwrite** | the **delta** is applied | one file on disk is one file's worth of quota |
| **Overwrite by another user** | old owner `-=` old size, writer `+=` new size, owner changes | the bytes on the disk are the ones the writer just put there |
| **Overwrite by no one** (storage scanner sees the file changed on the backend) | delta applied, owner **unchanged** | nobody uploaded it; the existing owner still holds it |
| **Trash** (soft delete) | **nothing** | the bytes are still on the storage — deleting does not free space, emptying the trash does |
| **Restore** | **nothing** | they never stopped counting |
| **Move / rename** (including between folders) | **nothing** | same row, same owner, same bytes |
| **Move between storages** | **nothing** if the row moves; a copy-then-delete nets to zero | the account stores it once either way |
| **Copy** | counted **again** | a copy really is a second set of bytes on the disk |
| **Purge / permanent delete** | subtracted | the bytes are gone |

The purge is the **only** release point. That is what makes "delete does not
free space" true rather than aspirational, and it is why a user cannot get
under their ceiling by filling the trash.

### Who the bytes belong to

Attribution is resolved in this order:

1. an **explicit owner** on the request context (`quotastore.WithOwner`) — used
   where the writer is not the account being billed:
   - the **public file-drop link** bills the link's creator. The uploader is
     anonymous by design, but the files land in the creator's storage, so they
     are the creator's bytes. Without this the drop would be the one write
     surface with no ceiling at all;
   - the **async copy worker** bills the owner of the **source** file. It runs
     on a server-lifetime context long after the request is gone.
2. the **authenticated account** — every logged-in surface, including WebDAV
   Basic auth and API-token writes (a token is bound to an account).
3. **nobody**. A file the storage scanner discovered was not uploaded through
   filex, so it stays unowned and uncounted — until a user overwrites it, at
   which point it becomes theirs.

### Reconciling

`POST /api/admin/users/{id}/quota/recompute` rebuilds **both** `usage_bytes`
and `usage_files` from the node rows using exactly the identities above —
**trashed rows included**. Both in one pass, on purpose: they describe the same
rows, and leaving one of them to a second endpoint is how they come to
disagree. Run it
if you have restored a database from an inconsistent backup, or after a bulk
import that bypassed filex.

> ⚠ Before v0.20 the reconciler filtered `deleted_at IS NULL`, so a recompute
> silently forgave every trashed byte and the release at purge then subtracted
> them a second time (clamped at zero, so the drift never showed up as an
> error). Fixed; the two now agree by construction.

## Where it is enforced

| Guard | Response |
|---|---|
| **Byte ceiling** | `413` `{"error":"quota exceeded","code":"QUOTA_EXCEEDED"}` |
| **File ceiling** | `413` `{"error":"file limit reached","code":"FILE_LIMIT_EXCEEDED","limit":N,"used":M}` |
| **Upload window** | `429` `{"error":"upload limit reached","code":"UPLOAD_RATE_LIMITED","retry_after_seconds":S}` + header `Retry-After: S` |
| **Staging disk headroom** | `507` `{"code":"NO_DISK_SPACE"}` |

The rate refusal is a **429 and not a 413** on purpose: `413` says "this will
never fit" and the client's correct reaction is to give up, while the rate limit
says the opposite — the same request succeeds later, and `Retry-After` says
when. The value is exact rather than a guess: it is the time until the **oldest
ledger row inside the window** falls out of it (floored at one second).

Each surface, and what it claims:

| Surface | Bytes | Files | Window |
|---|---|---|---|
| staged `begin` | declared size + this user's open staged bytes | `1`, or `0` when a file already sits at the target | ✅ |
| staged `commit` | — | — | spends the allowance (one ledger row) |
| multipart `?action=upload` | the whole batch, before the first write | the count of **new** names in the batch | ✅ (one ledger row per file that lands) |
| `?action=newfile` | `0` | `1` | — (nothing was transferred) |
| save-text, **create** | the whole body | `1` | ✅ |
| save-text, **overwrite** | the **delta** only | `0` | — (editing is not a transfer; charging every `Ctrl+S` would exhaust a window in a morning) |
| public drop / `IngestFile` | the file | `1`, or `0` on an overwrite | ✅ when there is an authenticated uploader |
| WebDAV `PUT` | Content-Length | `1`, or `0` on an overwrite | **no** |
| S3 / SFTP / FTP / NFS gateways | ✅ | — | **no** |

> ⚠ **What is NOT rate-limited.** WebDAV and the S3/SFTP/FTP/NFS gateways check
> the two **storage** ceilings only (`quota.Service.CheckCanStore`). They are
> long-lived mounted sessions, and the only refusal WebDAV can express at that
> point is `507 Insufficient Storage` — x/net/webdav turns a `Close` error into
> `405`, which tells a client to stop using the method entirely. Spelling a
> temporary rate refusal as "you are out of space" would be a worse lie than not
> enforcing it there. If you need the window enforced on those surfaces, set a
> byte ceiling instead.

The byte ceiling is checked against `usage_bytes` **plus the bytes already
reserved by this user's open staged uploads**. Reserving at `begin` rather than
settling at commit is deliberate: an upload that never commits would otherwise be
invisible to the ceiling and a user could stage past it. The reservation is
derived from the open rows themselves, so it is released by the row leaving the
open set — commit, abort, or sweep — and can never drift from what it describes.

Every guard increments
`filex_guard_refusals_total{guard="quota"|"files"|"upload_rate"|"disk"}` and
writes a log line naming the numbers involved. See [Metrics](METRICS.md).

## The upload window

`upload_ledger` holds **one row per completed upload** — `(user_id, bytes,
created_at)`. The limit is `SUM(bytes)` inside the last
`quota.upload_window_hours`, so the window **slides**: there is no reset moment
at which everybody's allowance comes back at once, and a user who uploaded at
23:59 does not get a fresh allowance one minute later.

Two consequences worth stating plainly:

- **Deleting does not give the allowance back.** The storage ceiling is about
  what you keep; the window is about what you moved. The transfer already
  happened.
- **A refused, aborted or failed upload spends nothing.** The row is written on
  the success path only — after a staged `commit` is accepted, or after a
  multipart part has actually landed.

Rows that have fallen out of the window hold nobody's allowance any more and are
deleted by the staged-upload sweeper on its normal cadence
(`FILEX_UPLOAD_SWEEP_INTERVAL`), which always keeps at least one whole window.

## The admin API

| Route | Body / query | Answer |
|---|---|---|
| `GET /api/admin/quotas` | — | `{"defaults":{"quota_bytes","quota_files","upload_bytes","upload_window_hours"}}` |
| `PATCH /api/admin/quotas` | any subset of those four | validated (≥ 0; window 1–720), then the same shape as `GET` |
| `GET /api/admin/quotas/users` | `?limit=&offset=&q=` (default 50, max 200; `q` matches e-mail or display name) | `{"users":[…],"total","limit","offset"}` |
| `GET /api/admin/users/{id}/quota` | — | the snapshot **plus** `"overrides"` (the raw tri-state) |
| `PATCH /api/admin/users/{id}/quota` | `{quota_bytes?, quota_files?, quota_upload_bytes?}`, each `-1 \| 0 \| N` | the same as `GET` |
| `POST /api/admin/users/{id}/quota/recompute` | — | `{"ok":true,"used_bytes","used_files"}` |
| `GET /api/files/quota/me` | — | the snapshot, **without** `overrides` |

A `PATCH` sets only the fields it names, so editing one ceiling never blanks
another, and a `PATCH` that fails validation on **any** field writes **none** of
them. `POST` is kept as an alias of `PATCH` on the per-user route.

One row of `/api/admin/quotas/users`:

```json
{
  "id": 7, "email": "a@b.local", "display_name": "Ann", "role": "user",
  "overrides": { "quota_bytes": 0, "quota_files": -1, "quota_upload_bytes": 0 },
  "effective": { "quota_bytes": 1048576, "quota_files": 0, "upload_bytes": 0 },
  "used_bytes": 4096, "used_files": 3, "upload_used_bytes": 512
}
```

## Where it is implemented

All of it lives in **one** place: `internal/quotastore`, a `db.Store` decorator
that overrides `CreateNode`, `UpdateNodeMeta` and `HardDeleteNode`. Every write
surface — browser upload, staged upload, staged ingest, WebDAV `PUT`, the public
drop, ShareX, the AI/REST API, save-text, archive extract, copy — reaches it
through the store, so none of them carries quota code and a write path added
next month is counted on the day it is written.

> ⚠ **History.** Until v0.20 `quota.AddUsage` and `Store.SetNodeOwner` had **no
> callers anywhere in the tree**. `usage_bytes` was never incremented,
> `GetNodeOwner` always returned `nil`, and so the `SubUsage` at purge — the
> only place it was called — could never run either. Nothing was counted, so
> nothing was ever refused: a user with a 1 MB quota could upload 10 GB. The
> ceiling, the admin page and the "trashed bytes still count" rule were all
> describing behaviour that did not exist.
