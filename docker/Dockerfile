# filex image — slim or full, selected by the RUNTIME_BASE build argument:
#
#   docker build -f docker/Dockerfile -t filex:slim .                  # default
#   docker build -f docker/Dockerfile -t filex:full \
#     --build-arg RUNTIME_BASE=tools .
#
# slim carries the Go binary and nothing else. Image thumbnails are produced in
# pure Go (internal/thumb/image.go) and work there; every thumbnail that shells
# out to another program needs the toolchain, which is the `tools` stage below.
# filex probes for each tool at start (internal/capability) and reports what it
# found on /api/files/capabilities, so a missing one is a disabled feature with
# a reason, not a crash.
#
# RUNTIME_BASE takes a stage name OR an image reference, which is what keeps
# the two concerns apart: `tools` builds the toolchain from this file with no
# registry involved, and a published toolchain image skips that build to reuse
# layers the registry already has. CI passes the image; everyone else can pass
# the stage. Neither is required to have the other.
#
# ⚠ This replaced `--target slim|full`. The targets are gone on purpose: the
# recipe below installs NO thumbnail tool, so there is no longer a line anyone
# can add to it that silently fattens slim — the bug that shipped a 511 MB
# "~40 MB" image for eleven releases up to v0.31.0.
#
# Office documents are the exception in BOTH variants: their converter is a
# separate service (FILEX_LIBREOFFICE_URL), because bundling LibreOffice costs
# more than the whole toolchain image put together.
#
# Run:
#   docker run -p 5212:5212 -v $(pwd)/data:/data filex:full
#
# Multi-arch: build stages are pinned to $BUILDPLATFORM so the Node/Go work
# always runs natively on the build host; the Go stage cross-compiles via
# TARGETOS/TARGETARCH (CGO=0 makes this free). Only the runtime stage runs
# per-target-arch, under QEMU when cross-building — and it is now one apk line
# and a COPY, because the heavy installs moved to the tools image.
#   docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile .

# Declared here and not next to the runtime stage it feeds: an ARG used in a
# FROM line has to be global, i.e. before the first FROM. See "Runtime" below
# for what the values mean.
ARG RUNTIME_BASE=alpine:3.20

# ---------------------------------------------------------------------------
# Stage 1: npm packages (core, webcomponent, react) + admin UI + end-user app
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-build
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /src

# Manifests first so the dep layer survives source edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/webcomponent/package.json ./packages/webcomponent/
COPY packages/react/package.json ./packages/react/
COPY web/package.json ./web/
COPY app/package.json ./app/

# vue-tsc OOMs the default 1.7 GB Node heap once the workspace core package
# (code-split viewers) is pulled in. 4 GB for every Node process in the build.
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN pnpm install --frozen-lockfile

COPY packages/ ./packages/
COPY web/ ./web/
COPY app/ ./app/

# Packages first: web imports their types, and the webcomponent dist is embedded
# into the Go binary.
RUN pnpm -r --filter='./packages/*' build
RUN pnpm --filter='./web' build

# The end-user app, which the binary serves at the apex (wireStatic in
# backend/internal/api/routes.go).
#
# VITE_FILEX_API is read at BUILD time and app/vite.config.ts refuses a
# production build without it, rather than shipping the mock repository behind a
# real-looking UI. "1" is the same-origin form: the app is served by the binary
# that answers /api.
#
# BUILD_APP=0 skips this build and leaves embed/app holding only a `.keep`.
# That is a supported shape, not a broken one: wireStatic probes for
# index.html, finds none, and serves the admin console at the apex instead.
# The placeholder is required — `//go:embed all:app` fails on an EMPTY dir.
ARG BUILD_APP=1
ENV VITE_FILEX_API=1
RUN if [ "$BUILD_APP" = "1" ]; then \
        pnpm --filter='./app' build; \
    else \
        rm -rf app/dist && mkdir -p app/dist && touch app/dist/.keep; \
    fi

# ---------------------------------------------------------------------------
# Stage 2: stage embed assets for the Go build to consume
# ---------------------------------------------------------------------------
FROM frontend-build AS embed-prep
RUN mkdir -p /tmp/embed/admin /tmp/embed/web /tmp/embed/app && \
    cp -r /src/web/dist/. /tmp/embed/admin/ && \
    cp -r /src/packages/webcomponent/dist/. /tmp/embed/web/ && \
    cp -r /src/app/dist/. /tmp/embed/app/

# ---------------------------------------------------------------------------
# Stage 3: the Go binary with embedded assets
# ---------------------------------------------------------------------------
# 1.25 for golang.org/x/image v0.39+ (BMP/TIFF/WebP decoders imported by
# internal/thumb/image.go).
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS backend-build
RUN apk --no-cache add git ca-certificates
WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
COPY --from=embed-prep /tmp/embed/admin ./embed/admin
COPY --from=embed-prep /tmp/embed/web   ./embed/web
COPY --from=embed-prep /tmp/embed/app   ./embed/app

ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown
# TARGETOS/TARGETARCH are set by buildx per requested platform; empty on a plain
# `docker build`, where Go falls back to the host defaults.
ARG TARGETOS
ARG TARGETARCH
# The -X symbol path must match the real module path, so it is read from go.mod
# rather than written out here: the linker silently skips an -X it cannot
# resolve, and the version would fall back to "0.1.0-dev (unknown, unknown)"
# with no build error. Keeps a fork that renames the module working.
RUN MODULE="$(go list -m)" && \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build \
    -trimpath \
    -ldflags="-s -w \
        -X ${MODULE}/internal/version.Version=${VERSION} \
        -X ${MODULE}/internal/version.Commit=${COMMIT} \
        -X ${MODULE}/internal/version.Date=${DATE}" \
    -o /out/filex \
    ./cmd/filex

# ---------------------------------------------------------------------------
# Stage 4: runtime toolchain (off the main path)
# ---------------------------------------------------------------------------
# The programs the thumbnailer shells out to. Only built when something asks
# for it: BuildKit builds a stage only if the target depends on it, and the
# default target (runtime on plain alpine) does not. So `slim` never pays for
# this, and no line added here can fatten it — the structural guarantee that
# the old `--target slim|full` did not have.
#
#   docker build -f docker/Dockerfile --build-arg RUNTIME_BASE=tools .
#
# It lives here rather than in a file of its own so that building `full` from
# source needs no image from any registry: `FROM ${RUNTIME_BASE}` resolves a
# STAGE NAME before it resolves a repository, so `RUNTIME_BASE=tools` is a
# local build and `RUNTIME_BASE=<a published image>` is the cached one, from
# the same recipe. CI passes the published image (see "Runtime" below); a fork,
# an air-gapped build or anyone without access to that namespace passes `tools`.
#
#   ca-certificates — outbound TLS (S3, WebDAV, OIDC, update checks).
#   tzdata          — local-time rendering and scheduled jobs.
# Both are installed by the runtime stage too, which is a no-op on this base;
# they are here so this stage is a complete runtime base on its own.
#
#   ffmpeg                 — video + audio thumbnails (thumb/video.go, audio.go).
#   ghostscript + poppler  — PDF -> JPEG (page 1). gs preferred, pdftoppm as
#                            fallback (thumb/pdf.go).
#   rsvg-convert           — SVG rasterisation (thumb/svg.go).
#   fonts                  — without them Ghostscript renders the non-ASCII text
#                            of a PDF that embeds no font as boxes.
#
# ⚠ LibreOffice is NOT here, and adding it costs ~730 MB (libreoffice 558 MB +
# the openjdk17 JRE its xlsx/docx pipeline needs, 172 MB — measured on
# alpine:3.20). Office thumbnails go through a conversion SERVICE instead:
# FILEX_LIBREOFFICE_URL, or the `libreoffice` profile in docker-compose.yml.
#
# ⚠ Nothing in filex executes ImageMagick — it was installed and probed for
# years without a single call site. Image thumbnails are pure Go
# (thumb/image.go). Do not add it back without a generator that uses it.
FROM alpine:3.20 AS tools
RUN apk --no-cache add \
        ca-certificates \
        tzdata \
        ffmpeg \
        ghostscript \
        poppler-utils \
        rsvg-convert \
        ttf-liberation \
        ttf-dejavu \
        font-noto \
        font-noto-cjk

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
# RUNTIME_BASE is the whole slim/full switch:
#
#   alpine:3.20   (the default)              → slim (~179 MB)
#   tools         (the stage above)          → full (~535 MB), built here
#   <a published toolchain image>            → full (~535 MB), pulled
#
# The last form is an optimisation, not a dependency: it exists so a weekly
# release does not rebuild ~340 MB of packages that change a few times a year.
# When it is used the tag is PINNED and dated by whoever builds (CI passes it
# explicitly; see .github/workflows/release.yml), never floating — a toolchain
# upgrade has to be a deliberate change, not something that lands in a release
# by itself.
#
# ca-certificates and tzdata are installed here rather than assumed, so the
# default alpine base works with no network dependency on a published tools
# image. On the tools base the line is a no-op.
#   ca-certificates — outbound TLS (S3, WebDAV, OIDC, update checks).
#   tzdata          — local-time rendering and scheduled jobs.
#
# The binary is copied in last so a code change never invalidates the layers
# below it.
FROM ${RUNTIME_BASE} AS runtime
RUN apk --no-cache add ca-certificates tzdata

EXPOSE 5212
VOLUME ["/data"]

ENV FILEX_DATA_DIR=/data \
    FILEX_LISTEN=0.0.0.0:5212 \
    FILEX_THUMBS_ENABLED=true

# /healthz is mounted unauthenticated by the server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:5212/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/filex"]
CMD ["serve"]

COPY --from=backend-build /out/filex /usr/local/bin/filex
