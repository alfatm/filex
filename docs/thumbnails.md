# Thumbnails

filex renders preview thumbnails **server‑side** for images, video, audio, PDFs,
office documents and SVGs, and a coloured placeholder card for everything else.
Thumbnails are **on by default** — the grid view shows a real preview where one
exists and falls back to a per‑type icon where it doesn't.

The image and placeholder generators are pure Go and always work. The richer
kinds (video, audio, PDF, office, SVG) each shell out to an **external tool**
that filex **auto‑detects on `PATH`** at startup — if the tool is missing, that
kind degrades gracefully instead of erroring.

- [How it works](#how-it-works)
- [Generators & required tools](#generators--required-tools)
- [Configuration](#configuration)
- [Reclaiming the cache](#reclaiming-the-cache)
- [The Docker image & bundled tools](#the-docker-image--bundled-tools)
- [Serving](#serving)
- [Backfill — catching up existing files](#backfill--catching-up-existing-files)
- [Resetting thumbnails](#resetting-thumbnails)
- [What happens if it isn't configured / a tool is missing](#what-happens-if-it-isnt-configured--a-tool-is-missing)
- [Failure modes & troubleshooting](#failure-modes--troubleshooting)
- [See also](#see-also)

---

## How it works

The pipeline (`backend/internal/thumb/`) is a **dispatcher**: it decides a
file's kind and routes it to exactly one generator. The **file extension wins**
whenever it names a kind the dispatcher knows; the catalogued MIME decides only
for the rest.

> ⚠ That order matters more than it looks. The catalogued MIME is sniffed from
> the first 512 bytes, and an **SVG has no magic number** — so every `.svg` on a
> local storage is stored as `text/plain`, which used to match neither SVG
> branch and land the file on the generic placeholder card, on installs with
> librsvg present. No reset could repair it: regeneration read the same wrong
> MIME. Sniffing is repaired at the source too (`storage.RefineMime`), but a row
> catalogued before that stays wrong until its file changes, so the thumbnail
> does not depend on a re-sync to be right. Legacy `.doc` / `.xls` / `.ppt`,
> which sniff as an OLE blob, reach LibreOffice for the same reason.

Every generator writes a **JPEG** to the cache directory as
`<cache_dir>/<nodeID>.jpg` (regardless of source kind, the cache file is always
`<id>.jpg`, roughly **320 px** on the long edge) and updates a row in the
`thumbnails` table with a **state**:

| State | Meaning |
|---|---|
| `pending` | Dispatched, not finished yet (or left over from a crash). |
| `ready` | A JPEG is cached and servable. |
| `skipped` | No generator applied (e.g. SVG with no `rsvg-convert`). Not an error. |
| `failed` | A generator ran but errored (broken file, tool crash). Logged at WARN with the error stored on the row. |

Generation is triggered two ways:

1. **After upload** — the moment an upload (or a public file‑drop) commits, filex
   dispatches the pipeline in a **detached background goroutine** with a **90‑second
   timeout**. The HTTP request returns immediately; a client disconnect can't abort
   an in‑flight office→PDF conversion. Errors are swallowed (the pipeline logs its
   own).
2. **Backfill** — a one‑shot pass over files that already exist in the cache (see
   [Backfill](#backfill--catching-up-existing-files)).

Cached JPEGs are released two ways, both described in
[Reclaiming the cache](#reclaiming-the-cache).

---

## Generators & required tools

| Kind | Source types | Generator | External binary (auto‑detected on `PATH`) |
|---|---|---|---|
| **Image** | `image/*` — jpg, png, gif, bmp, tiff, webp | Built‑in Go (stdlib + `x/image`) | **none** |
| **Small image** | jpg, png, gif, webp under **500 KB** | *(none — `state=skipped`)* | **none** — the client shows the file itself as the tile; a 320px JPEG next to a 100 KB original would save nothing. `thumb.SmallImageBytes`, mirrored by `SMALL_IMAGE_BYTES` in the app |
| **Video** | `video/*` — mp4, webm, mov, mkv, avi, … | `ffmpeg` — first frame at ~1 s, scaled to 320 wide | `ffmpeg` |
| **Audio** | `audio/*` — mp3, wav, ogg, flac, m4a, aac, opus | `ffmpeg` — a 320×120 waveform image (`showwavespic`) | `ffmpeg` |
| **PDF** | `application/pdf` | Ghostscript renders page 1 at 96 dpi (falls back to poppler) | `gs` **or** `pdftoppm` |
| **Office** | doc, docx, xls, xlsx, ppt, pptx, odt, ods, odp | LibreOffice → PDF → page 1 rendered like a PDF | an **office conversion service** (`FILEX_LIBREOFFICE_URL`) *or* a local `libreoffice` / `soffice` — **and** one of `gs` / `pdftoppm` |
| **SVG** | `image/svg+xml` | librsvg rasterises to PNG → re‑encoded to JPEG | `rsvg-convert` |
| **Placeholder** | everything else — archives, 3D models, code, markdown, rtf, raw docs, … | Built‑in Go — a tinted card with the extension centred (colour hashed from the extension) | **none** |

Notes:

- **Images** decode with the Go standard library plus `golang.org/x/image`
  (BMP / TIFF / WebP), capped at **~50 MB** of decoded input, and are downscaled
  to fit **320×320** (aspect preserved; larger sources only) and encoded at JPEG
  quality **80**. Formats Go can't decode — e.g. **HEIC / AVIF** — will `state=failed`.
- **SVG is checked before the generic `image/*` branch**, because Go's decoder
  can't parse SVG. If `rsvg-convert` isn't present the SVG is cleanly
  **`skipped`**, never failed.
- **Office** goes through **two** stages: LibreOffice makes a PDF, then
  Ghostscript/poppler rasterises page 1. Only the second stage is in the filex
  image. The first is a **separate service** — see
  [The office conversion service](#the-office-conversion-service).

---

## Configuration

| Setting | Default | Where | Meaning |
|---|---|---|---|
| `FILEX_THUMBS_ENABLED` | `true` | env | Master switch. Accepts `1` or `true` (case‑insensitive) as **on**; any other value is off. **Off** means: nothing is rendered (no row is written either, so turning it back on needs no `--retry-skipped`), `/api/capabilities` reports every `thumbs.*` kind `false`, and the admin reset endpoints answer **503**. Read at boot — changing it takes a restart. |
| `FILEX_THUMB_BACKFILL_ON_BOOT` | *(unset)* | env | Set `once` (or `true` / `1`) to run one background backfill on startup. See [Backfill](#backfill--catching-up-existing-files). |
| `thumbs.cache_dir` | `<data_dir>/thumbs` | **config.yaml only** | Directory the cached `<id>.jpg` files live in. No env override. |
| `thumbs.formats` | `[image, video, pdf, office]` | **config.yaml only** | Declares the kind list. No env override. |
| `FILEX_THUMBS_SWEEP_INTERVAL` | `6h` | env / `thumbs.sweep_interval` | How often the cache is reconciled against the node catalogue. `0` disables the sweeper entirely. See [Reclaiming the cache](#reclaiming-the-cache). |
| `FILEX_LIBREOFFICE_URL` | *(unset)* | env / `external_services.libreoffice` / admin UI | Base URL of the office→PDF conversion service. The **only** thumbnail setting that is a URL, because it is the only tool that isn't a local binary. Applies **without a restart** when set from *Settings → External services*. See below. |

Apart from that one, there is **no env var or config key for the external
tools** — filex probes `PATH` at boot (`ffmpeg`, `gs`, `pdftoppm`,
`libreoffice`/`soffice`, `rsvg-convert`) and enables each kind accordingly. In
practice a kind renders when its MIME type matches **and** its tool is present;
`cache_dir` is the `thumbs.*` value read at runtime.

---

## The office conversion service

LibreOffice is not in any filex image, and that is deliberate: it costs **~730
MB** (558 MB plus the 172 MB OpenJDK 17 JRE its xlsx/docx pipeline calls
`javaldx` from), which is more than everything else in the `full` image put
together, and it forks a whole office suite per document. So it runs as its own
service and filex posts documents to it over HTTP.

The protocol is [Gotenberg](https://gotenberg.dev)'s LibreOffice route —
`POST <url>/forms/libreoffice/convert`, the document in a `files` multipart
field, a PDF in the response body — so any Gotenberg-compatible deployment
works. filex uses nothing else from the API.

```dotenv
COMPOSE_PROFILES=libreoffice
FILEX_LIBREOFFICE_URL=http://libreoffice:3000
```

The bundled `libreoffice` profile in `docker-compose.yml` runs
`gotenberg/gotenberg:8` on the internal network with the Chromium routes turned
off. The URL is **server-side only** — unlike OnlyOffice it is never handed to a
browser — so an in-network address is the correct value, and the service should
not be published on a host port.

It is an entry in `external_services` like OnlyOffice and drawio — named
`libreoffice`, kept deliberately distinct from `onlyoffice`, which sits next
to it in the same list and does something entirely different (editing in a
browser, never conversion). Which means
*Settings → External services → libreoffice* can point filex at one live, with a
**Test** button that probes `GET <url>/health`, and `/api/files/capabilities`
reports `thumbs.office` true once a URL is configured.

**Without either converter**, office documents land `state=skipped` with the
reason `no office converter (set FILEX_LIBREOFFICE_URL, or install
libreoffice)` —
recoverable with `filex thumb backfill --retry-skipped` once one exists.

> A host that already has `libreoffice` or `soffice` installed keeps using it,
> with no service and no configuration. The remote converter wins when both are
> available.

---

## Reclaiming the cache

A thumbnail outlives nothing: when its file is gone for good, so are its bytes.

**At the moment of deletion.** Purging a file — emptying the trash, a retention
expiry, or "delete permanently" — removes its `<id>.jpg` and its `thumbnails`
row there and then, so the space comes back when the user asks for it.

⚠ **Trashing a file does not.** A trashed file is restorable and keeps its
thumbnail, so it is on screen the instant it comes back.

**The sweeper.** Every `FILEX_THUMBS_SWEEP_INTERVAL` (and once at boot) filex
walks the cache directory and deletes files whose node no longer exists. This is
what repairs an install that has been accumulating orphans — from a removed
storage, a sync tombstone, or simply from a version of filex that never cleaned
up at all — and it logs one line per pass, including the passes that delete
nothing:

```
thumb cache sweep dir=/data/thumbs scanned=20412 removed=317 freed_bytes=6114233 kept=20095 skipped=0 interval=6h0m0s
```

A file is deleted only when **all** of the following hold, which is what makes
the sweeper safe to run unattended:

1. its name is exactly `<digits>.jpg` — nothing else in the directory is ever a
   candidate, so a file you put there yourself is left alone;
2. the database **positively reports** that node id absent from `nodes`. A
   trashed node still has a row. If the query fails, the pass is abandoned and
   nothing is deleted — "I could not ask" is never read as "it is gone";
3. node ids are never reused (`AUTOINCREMENT` on SQLite, `BIGSERIAL` on
   Postgres), so an id that is absent today cannot acquire a file tomorrow;
4. the file has not been written within the last 10 minutes, so a thumbnail
   still being generated is never judged mid‑flight.

Set `FILEX_THUMBS_SWEEP_INTERVAL=0` to turn it off; nothing else in filex
removes a cached thumbnail on a schedule.

---

## The Docker image & bundled tools

Image thumbnails and placeholder cards work on **any** image, including the
smaller **`:slim`** image, because they need no external binary.

The default **`ghcr.io/brf-tech/filex:latest`** image bundles the tools that
unlock the richer kinds:

```
ffmpeg          → video + audio thumbnails
ghostscript     → PDF (page 1)  ┐ office docs render via
poppler-utils   → PDF fallback  ┘ the office service → PDF → these
rsvg-convert    → SVG
fonts (noto/liberation/dejavu)  → so PDF text isn't rendered as boxes
```

> **LibreOffice is not in the list** — office documents need the
> [conversion service](#the-office-conversion-service). It used to be bundled,
> and dropping it took the `full` image from **1.28 GB to 525 MB** (`slim` is
> 180 MB and carries none of these).

> The stock `full` image ships `rsvg-convert` (librsvg) too, so SVG thumbnails
> work on it. Whatever image you run, the definitive check for what's actually
> present is the [capabilities probe](#serving) (`thumbs.svg`, `thumbs.video`, …)
> — a kind whose tool is missing reports `false` there and lands its files in
> `skipped`, never in a placeholder.

These tools are not installed by the filex recipe: they are a **separate
image**, `docker/Dockerfile.tools`, published as
`ghcr.io/brf-tech/filex-tools:alpine<version>-<YYYYMMDD>` on its own cycle, and
`full` is that image with the filex binary on top (`--build-arg RUNTIME_BASE`).
They change a few times a year and filex changes weekly, so the two have no
reason to be rebuilt together — and `slim` cannot accidentally acquire them,
because no line of `docker/Dockerfile` installs a thumbnail tool.

If you build your own leaner image, copy `docker/Dockerfile.tools`, drop what
you don't need and point `RUNTIME_BASE` at it — the capability probe will
report `video=false` / `pdf=false` / etc. and the pipeline routes around the
missing generators automatically.

---

## Serving

```
GET /api/files/thumb/{id}
```

- Returns **404** unless the node's thumbnail state is **`ready`** and the cached
  JPEG exists on disk.
- On success: `Content-Type: image/jpeg`, an `ETag` derived from the cached file,
  and `Cache-Control: private, no-cache` — *store it, but ask first*. A repeat
  request carrying `If-None-Match` gets a bodiless **304**, so the steady state
  costs no bytes; a **regenerated** thumbnail is visible immediately.

  > ⚠ This used to be `private, max-age=86400` under a URL that is the node id
  > and nothing else, which made every regeneration invisible for a day: an admin
  > who reset the cache kept seeing the old picture and concluded the reset had
  > not worked.
- **Auth‑light.** The endpoint accepts either a normal authenticated **session**
  (the SPA's grid uses this) **or** an optional **signed URL** — `?sig=<hex hmac>`,
  an HMAC‑SHA256 of the id under the daily‑rotated `thumb_signing_key` setting.
  A bad id returns **400**; a bad signature returns **403**.
- File listings include a `thumb_url` per node so the grid knows where to fetch.

Capabilities (used by the UI and handy for debugging) are exposed at
`GET /api/files/capabilities` (legacy alias `GET /api/capabilities`) under
`thumbs`:

```bash
curl https://files.example.com/api/files/capabilities | jq .thumbs
```
```json
{ "image": true, "video": true, "audio": true,
  "pdf": true, "office": true, "svg": false }
```

(The probe result is cached for 1 hour.)

---

## Backfill — catching up existing files

New uploads get a thumbnail automatically, and so does a file the storage
**sync** catalogues or sees change — the walk queues a `thumb` op for it on the
persistent ops queue, where a bounded worker pool renders it (uploads keep their
priority over discovered files). Files that entered the cache before that
existed, an install without a persistent queue, or one that previously ran
**without** the tools, still have empty rows. The `thumb backfill` command walks
every file node and (re)dispatches the pipeline:

```bash
filex thumb backfill                     # every enabled storage
filex thumb backfill --storage local     # one storage, by name
filex thumb backfill --storage 2         # one storage, by id
filex thumb backfill --limit 100         # stop after 100 files (across all storages)
filex thumb backfill --retry-failed      # also re-run rows in state=failed
filex thumb backfill --retry-skipped     # also re-run rows in state=skipped
filex thumb backfill --concurrency 8     # worker pool size (default 4)
filex thumb backfill --progress-every 50 # progress line every N files (default 25)
```

Which files are (re)processed:

| Existing state | Re‑run? |
|---|---|
| *(no row)* / `pending` | Always. |
| `ready` | Never (idempotent). |
| `skipped` | Only with `--retry-skipped`. |
| `failed` | Only with `--retry-failed`. |

The walk skips trashed and soft‑deleted nodes. It ends with a summary line —
`{processed: N, ok: M, failed: K, skipped: S}` — and exits **non‑zero only on
infrastructure errors** (DB unreachable, unknown `--storage`, …); per‑file
failures are counted into `failed` but don't abort the run.

> ⚠ **Search index lock.** A running `filex serve` holds an exclusive lock on the
> Bleve (boltdb) search index. Backfill never touches search, so it **disables
> the index for its run** (sets `FILEX_SEARCH_ENABLED=false` unless you've
> already set it) — otherwise it would block indefinitely acquiring that lock.
> Only override `FILEX_SEARCH_ENABLED=true` when running backfill on a stopped
> node.

### Boot-time backfill

For containers where you want each restart to make sure the grid is painted:

```
FILEX_THUMB_BACKFILL_ON_BOOT=once
```

(values `once`, `true`, `1` are equivalent; anything else leaves it off). When
set, `serve` launches **one** background backfill a couple of seconds **after**
the HTTP listener is up — so the boot path stays fast — and logs progress at INFO
via `slog` (`thumb backfill (boot): starting one-shot backfill`). It's off by
default; most operators prefer to trigger backfills explicitly.

---

## Resetting thumbnails

A backfill **never re-runs a `ready` row**, and a placeholder card is `ready`.
So an installation that ran without the thumbnail tools — the `slim` image has
none of them — keeps serving the tinted extension card for every video, PDF and
office document even after moving to `full`. Nothing regenerates it: the row has
to go first.

That is what a reset does. It drops the thumbnails in scope — the `thumbnails`
rows **and** their cached JPEGs — and starts a background backfill over the same
scope, so the grid repaints without a second click.

**In the admin UI:** *Storages* → *Reset thumbnails* on a drive's card, or
*Reset all thumbnails* in the page header. Both ask for confirmation and report
how many were cleared.

**Over the API** (admin session required):

```
POST /api/admin/storages/{id}/thumbs/reset   # one storage
POST /api/admin/thumbs/reset                 # every storage
```

Both answer **202** with `{"cleared":N,"regenerating":true}`. The clearing is
done by the time the response is written; the regeneration is only starting, and
logs its tally when it finishes (`thumb reset: regeneration done`).
`"regenerating":false` means this server has no backfill wired and the rebuild
is yours to run (`filex thumb backfill`).

⚠ Rows are deleted **before** the JPEGs, on purpose: the reverse order has a
crash window that leaves a `ready` row pointing at a file that is gone — a
thumbnail no backfill will ever rebuild. A leftover JPEG, by contrast, is simply
overwritten by the next generation for that node.

By hand, the equivalent is `DELETE FROM thumbnails …` plus `rm <data_dir>/thumbs/*.jpg`
and then `filex thumb backfill`.

---

## What happens if it isn't configured / a tool is missing

- **Thumbnails are on by default.** With zero external tools you still get real
  image previews plus placeholder cards for everything else.
- **Missing tool for video / audio / PDF / office** → state **`skipped`**, with the
  missing tool named in the row's `error` (`ffmpeg not in PATH`, `no PDF renderer
  (gs / pdftoppm) in PATH`, `no office converter (set
  FILEX_LIBREOFFICE_URL, or install libreoffice)`). No JPEG is written and the
  client draws its own per‑type artwork.

  > ⚠ Until v0.35 these became a **placeholder card in state `ready`** instead —
  > and `ready` is the one state a backfill never re-runs, so an install that had
  > once run without the tools kept a tinted rectangle where the video frame
  > belonged, permanently, even after moving to the `full` image. `skipped` is
  > recoverable: add the tool, then `filex thumb backfill --retry-skipped`.
- **SVG with no `rsvg-convert`** → state **`skipped`** (reason: `rsvg-convert not
  in PATH`). No placeholder is drawn; the UI shows its own SVG icon.
- **A generator that runs but errors** (tool present, but the file is broken /
  truncated / unsupported) → state **`failed`**, a WARN is logged, and the error
  text is stored on the row.
- **Unsupported / other kinds** (archives, 3D models, code, markdown, rtf, raw
  docs, …) always get the placeholder card (`ready`).

---

## Failure modes & troubleshooting

### The grid shows icons, not previews
The thumbnail isn't `ready`. Inspect the `thumbnails` table:

```bash
sqlite3 <data_dir>/instance.sqlite \
  "SELECT node_id, state, error FROM thumbnails ORDER BY node_id DESC LIMIT 20;"
```

`ready` rows serve a JPEG; `failed` rows carry the generator error in `error`;
`skipped`/absent rows fall back to the per‑type icon.

### Existing files never got thumbnails after I added the tools
Uploads generate automatically, but files already in the cache don't. Run
`filex thumb backfill` (or set `FILEX_THUMB_BACKFILL_ON_BOOT=once`). If a whole
storage is empty, run a **sync** first — backfill only walks nodes already in the
cache.

### Office documents land in `state=failed`
LibreOffice converted but the second stage failed, or LibreOffice itself did.
Usual causes: **no PDF renderer** (`gs`/`pdftoppm` missing → LibreOffice succeeds
but there's nothing to rasterise the PDF), a **missing JRE** or **fonts**, or a
**corrupt/truncated** source doc. The stock `full` image already ships the JRE
and fonts; check the `error` column for the LibreOffice/Ghostscript output.

### SVGs never render
`rsvg-convert` isn't on `PATH` — the capabilities probe shows `thumbs.svg:false`
and rows are `skipped`. The stock `full` image omits librsvg; install it
(`apk add rsvg-convert`) and re‑run with `--retry-skipped`.

### PDF or video previews are blank / missing
If the tool is entirely absent the row is **`skipped`** and names the tool in
`error`; install it and run `filex thumb backfill --retry-skipped`. If the tool is
present but the row is **`failed`**, read the stored error — a broken PDF, an
unreadable codec, or a permissions issue on the temp dir.

### HEIC / AVIF images fail
Go's decoder only handles JPEG, PNG, GIF, BMP, TIFF and WebP. HEIC/AVIF sources
end up `failed`. Convert them, or add an external converter upstream.

### Backfill seems to hang
It's almost certainly the search‑index lock — see the callout above. Backfill
disables search for its run by design; don't force `FILEX_SEARCH_ENABLED=true`
while `filex serve` is live.

### A regenerated file shows the old thumbnail
The cache lives at `<data_dir>/thumbs/<id>.jpg` and is safe to delete. Remove the
stale file (or the whole `thumbs/` dir) and re‑run `filex thumb backfill
--retry-failed` — the cache is regenerated lazily.

⚠ This also covers a case nobody does by hand: a file **replaced on the backing
storage**, which the storage sync now notices on every driver. The sync updates
the row, the search index and the antivirus verdict — and does **not** touch
the cached JPEG, so the grid keeps showing the old picture until something
removes the file. Same fix: delete `<data_dir>/thumbs/<id>.jpg`.

---

## See also

- [CONFIGURATION.md](CONFIGURATION.md) — full config/env reference
- [DOCKER.md](DOCKER.md) — image variants (slim vs full) and compose profiles
- [STORAGE.md](STORAGE.md) — storages and sync (where uploaded/synced files come from)
- [INSTALLATION.md](INSTALLATION.md) — running filex
