# Docker

`filex` ships two pre-built images and a profile-driven `docker-compose.yml`
that lets you assemble the stack you actually need.

- [Images](#images)
- [Compose profiles](#compose-profiles)
- [Volume layout](#volume-layout)
- [Reverse proxies](#reverse-proxies)
- [TLS termination](#tls-termination)
- [Backups](#backups)
- [Upgrade](#upgrade)

---

## Images

Sizes are what you download (the compressed layers), measured on an amd64
build of the current recipe. On disk after `docker pull` they unpack to
roughly two and a half times that — **180 MB** for `slim` and **525 MB** for
`full` (`docker images`, same build). Both numbers are real; the compressed one
is what a registry page shows you and the other is what your disk loses, so
neither belongs in a sentence alone.

| Tag | Size | Includes |
|---|---|---|
| `ghcr.io/brf-tech/filex:latest` | ~205 MB | The full toolchain. Alias for `full`. |
| `ghcr.io/brf-tech/filex:full` | ~205 MB | + ffmpeg, ghostscript, poppler-utils, rsvg-convert, fonts — the [toolchain image](#the-toolchain-image) with the binary on top. |
| `ghcr.io/brf-tech/filex:slim` | **~47 MB** | The Go binary and the embedded admin UI. Nothing else. |
| `:vX.Y.Z` / `:full-vX.Y.Z` | ~205 MB | Pinned full. |
| `:slim-vX.Y.Z` | ~47 MB | Pinned slim. |

The Go binary is identical in both — `slim` simply has none of the programs the
thumbnailer shells out to.

**Which one do you want?** `latest` if you want previews of PDFs, office
documents and video, which is most people. `slim` if filex is a file manager
for you and not a preview generator: it pulls in seconds and carries a fraction
of the attack surface. Image thumbnails work in both, because those are
produced in pure Go.

filex probes for each external tool at start and reports what it found on
`/api/files/capabilities`, so on `slim` a video thumbnail is a disabled feature
with a stated reason — not a crash and not a silent failure.

> ⚠ **`slim` was not slim before v0.30.x.** The tag was built from the full
> recipe, so this table promised ~40 MB while the registry served 511 MB. The
> number above is measured, not aspirational: `docker save … | gzip | wc -c`.

### The toolchain image

The programs the thumbnailer shells out to live in the **`tools` stage** of
`docker/Dockerfile` — a stage nothing reaches unless `RUNTIME_BASE` names it,
so it cannot fatten `slim`. The same stage is also published as an image by its
own workflow (`.github/workflows/tools-image.yml`) as
`ghcr.io/brf-tech/filex-tools:alpine<version>-<YYYYMMDD>`:

```
ffmpeg, ghostscript, poppler-utils, rsvg-convert,
ttf-liberation, ttf-dejavu, font-noto, font-noto-cjk   (~350 MB unpacked)
```

They change a few times a year; filex changes weekly. Split apart, a filex
release that touches no tool ships one binary layer on top of a base the
registry already has, instead of re-resolving and re-downloading the whole
toolchain on both architectures.

`RUNTIME_BASE` is the entire slim/full switch, and it takes **either a stage
name or an image reference**:

| `RUNTIME_BASE` | Result | Registry needed |
|---|---|---|
| unset (`alpine:3.20`) | slim | — |
| `tools` | full, toolchain built from this Dockerfile | no |
| a published toolchain image | full, toolchain pulled | yes |

The published image is a **cache, not a dependency**: it exists so a weekly
release does not re-resolve and re-download ~340 MB of packages that change a
few times a year. A fork, an air-gapped build, or anyone without access to that
namespace passes `tools` and gets the same result from source.

The tag releases are built on is **pinned and dated** in `TOOLS_TAG`
(`.github/workflows/release.yml`). Republishing the toolchain does not change
any release until someone bumps it.

### Build locally

```bash
# slim — the default base is plain alpine
docker build -t filex:slim -f docker/Dockerfile .

# full — build the toolchain from the same recipe (no registry needed)
docker build -t filex:full -f docker/Dockerfile \
  --build-arg RUNTIME_BASE=tools .

# or reuse the published toolchain image instead of rebuilding it
docker build -t filex:full -f docker/Dockerfile \
  --build-arg RUNTIME_BASE=ghcr.io/brf-tech/filex-tools:alpine3.20-20260911 .
```

Or through Compose, which is the same recipe with the tag and base read from
`.env` (`FILEX_IMAGE`, `FILEX_RUNTIME_BASE`):

```bash
docker compose up --build              # server + admin SPA + end-user app
BUILD_APP=0 docker compose up --build  # skip the app; the apex serves /admin/
```

Both variants come from one multi-stage Dockerfile:
1. `frontend-build` — node 20 + pnpm, builds packages, the admin UI and the end-user app (`/app/`)
2. `embed-prep` — stages the dist files
3. `backend-build` — golang 1.25, builds with `//go:embed` consuming the staged dist
4. `tools` — the thumbnail toolchain; off the main path, built only when `RUNTIME_BASE=tools`
5. `runtime` — `FROM ${RUNTIME_BASE}`: `alpine:3.20` for slim, the `tools` stage or the published toolchain image for full, plus ca-certificates/tzdata, the container metadata and the binary

Pass build-args to embed version metadata into the binary:
```bash
docker build \
  --build-arg VERSION=v0.1.0 \
  --build-arg COMMIT=$(git rev-parse --short HEAD) \
  --build-arg DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  -t brftech/filex:full -f docker/Dockerfile .
```

---

## Compose profiles

`docker-compose.yml` (repo root) defines:

| Service       | Profile      | Notes |
|---------------|--------------|-------|
| `filex`       | (default)    | SQLite + local storage; `FILEX_IMAGE` picks slim or full |
| `onlyoffice`  | `onlyoffice` | OnlyOffice Document Server |
| `postgres`    | `postgres`   | Postgres 16 (set `FILEX_DB_DRIVER=postgres`) |
| `minio`       | `minio`      | S3-compatible blob store |

The production-shaped stack in [`deploy/compose/docker-compose.full.yml`](../deploy/compose/docker-compose.full.yml)
adds three more profiles — `drawio`, `convert` and **`clamav`**. The last one
is how antivirus is meant to be run under Docker: **the filex images ship no
scanner** (ClamAV plus its signature database is close to a gigabyte), so
`clamav/clamav` runs as its own container and filex streams each file to it
over the network. Two settings and nothing else:

```yaml
services:
  filex:
    environment:
      FILEX_CLAMAV_ADDR: "clamav:3310"   # seeds daemon mode on first boot
  clamav:
    image: clamav/clamav:latest
    profiles: ["clamav"]
    volumes:
      - clamav-db:/var/lib/clamav        # keep signatures across restarts
```

⚠ `FILEX_CLAMAV_ADDR` — like every `FILEX_CLAMAV*` variable except `_BIN` — is
a **seed**, read on a boot where the setting has no stored row and never again.
After that the switch, the mode and the address live on *Settings → Protection*
([PROTECTION.md](PROTECTION.md#antivirus-clamav)).

Bring up with:

```bash
docker compose up                                     # filex alone
docker compose --profile onlyoffice up                # filex + OnlyOffice
docker compose --profile postgres --profile minio up  # full self-hosted stack
```

You can mix profiles freely:
```bash
docker compose --profile onlyoffice --profile postgres --profile minio up -d
```

Thumbnails are not a profile — one service cannot be two images. Point
`FILEX_IMAGE` at the full tag in `.env` instead:

```bash
FILEX_IMAGE=ghcr.io/brf-tech/filex:full
FILEX_THUMBS_ENABLED=true
```

### `.env`

Create `.env` next to `docker-compose.yml`:

```bash
# --- filex ---
FILEX_PUBLIC_URL=https://files.example.com
FILEX_AUTH_DRIVERS=oidc
FILEX_OIDC_ISSUER=https://auth.example.com/realms/main
FILEX_OIDC_CLIENT_ID=filex
FILEX_OIDC_CLIENT_SECRET=changeme
FILEX_DB_DRIVER=postgres
FILEX_DB_DSN=postgres://filex:changeme@postgres:5432/filex?sslmode=disable

# --- OnlyOffice ---
ONLYOFFICE_JWT_SECRET=please-change-me-shared-with-filex
FILEX_ONLYOFFICE_URL=https://docs.example.com
FILEX_ONLYOFFICE_JWT=please-change-me-shared-with-filex

# --- Postgres ---
POSTGRES_PASSWORD=changeme

# --- MinIO ---
MINIO_USER=filex
MINIO_PASSWORD=changeme-very-long
```

`docker-compose.yml` references all of these with safe defaults; secrets that
have no safe default use `${VAR:?msg}` and will fail-fast if missing.

---

## Volume layout

```
./data                       # FILEX_DATA_DIR — sqlite, search, thumbs, tmp
./storage-local              # default 'local' driver root (mounted into /var/lib/filex/local-storage)
filex-onlyoffice-data/       # docker volume (OnlyOffice docs)
filex-onlyoffice-logs/       # docker volume
filex-postgres-data/         # docker volume
filex-minio-data/            # docker volume
```

Use bind mounts (`./data`) when you want easy host-side backup; use named
volumes for everything Docker itself creates.

---

## Reverse proxies

filex always assumes a reverse-proxy in production. Set
`FILEX_TRUST_PROXY_HEADERS=true` so it honours `X-Forwarded-*`.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name files.example.com;
  ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

  client_max_body_size 5G;     # match FILEX_LIMITS_MAX_UPLOAD_BYTES
  proxy_request_buffering off;
  proxy_buffering off;
  proxy_read_timeout 600s;
  proxy_send_timeout 600s;

  location / {
    proxy_pass         http://127.0.0.1:5212;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Host  $host;
  }
}
```

### Traefik (docker labels)

```yaml
services:
  filex:
    # ...
    labels:
      - traefik.enable=true
      - traefik.http.routers.filex.rule=Host(`files.example.com`)
      - traefik.http.routers.filex.entrypoints=websecure
      - traefik.http.routers.filex.tls.certresolver=letsencrypt
      - traefik.http.services.filex.loadbalancer.server.port=5212
      - traefik.http.middlewares.filex-bigbody.buffering.maxRequestBodyBytes=5368709120
      - traefik.http.routers.filex.middlewares=filex-bigbody
```

### Caddy

```caddyfile
files.example.com {
  encode zstd gzip
  reverse_proxy filex:5212 {
    flush_interval -1
    transport http {
      response_header_timeout 600s
      read_timeout 600s
    }
  }
}
```

### Cloudflare Tunnel

Add a public hostname pointing to `http://filex:5212` and CF will set the
correct `X-Forwarded-*` headers automatically.

⚠ **Leave WebSocket support on.** filex serves a WebSocket at `GET /api/ws`,
and an open explorer that has one **does not poll** — the 12 s re-listing is
only the fallback for a socket that failed. Block the upgrade and every
browser silently degrades to a folder that refreshes twice a minute, which is
the shape of "I upload a file and it shows up ten minutes later". The MCP
stream at `/api/ai/mcp` needs the same. See
[Realtime](REALTIME.md) and [Deployment](DEPLOYMENT.md).

---

## TLS termination

Three options:

1. **Reverse proxy terminates** (recommended) — set
   `FILEX_PUBLIC_URL=https://...` and `FILEX_TRUST_PROXY_HEADERS=true`.
   filex itself listens plain HTTP on 5212.
2. **Cloudflare Tunnel** — same as above, but Cloudflare is the proxy.
3. **filex direct TLS** (NOT recommended for prod) — set
   `FILEX_TLS_CERT=/path/to/cert.pem` and `FILEX_TLS_KEY=/path/to/key.pem`.
   Useful only for one-off or air-gapped deploys.

---

## Backups

Stop-the-world isn't required if you back up the DB consistently:

### SQLite
```bash
sqlite3 data/filex.db ".backup '/backup/filex-$(date -u +%Y-%m-%dT%H%M%SZ).db'"
```

### Postgres
```bash
docker compose exec postgres pg_dump -U filex filex | gzip > /backup/filex.sql.gz
```

### Storage backends
Backup is per-storage-driver: snapshot the host path for `local`, lifecycle
S3 versioning + lifecycle for `s3`, etc. filex keeps no canonical state of
the file bytes — the storage is the source of truth.

### What's safe to lose

- `data/search.bleve/` — Bleve index. Rebuilt from the DB if missing.
- `data/thumbs/`  — Cache. Regenerated lazily; a cached file is released when
  its node is purged, and orphans are swept every `FILEX_THUMBS_SWEEP_INTERVAL`.
- `data/cache/`   — read cache for slow storages.
- `data/uploads/` — staging for chunked and resumable uploads. In-flight
  uploads will need to retry. ⚠ For a transfer that has not committed yet,
  this is the file's **only** copy.

What's **not** safe to lose:
- `data/instance.sqlite` (or your Postgres/MySQL DB) — auth, shares, audit, sync metadata.
- `data/.first-run.txt` — initial admin password (only useful pre-first-login).

---

## Upgrade

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on container start (goose). Rollbacks are
single-step and only intended for the same release line — across major
versions, **back up before upgrading**.

To pin a version:
```yaml
services:
  filex:
    image: brftech/filex:slim-v0.2.0
```
