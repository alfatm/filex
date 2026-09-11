# filex image — two targets from one recipe:
#
#   docker build -f docker/Dockerfile --target slim -t filex:slim .
#   docker build -f docker/Dockerfile --target full -t filex:full .   # default
#
# slim carries the Go binary and nothing else. Image thumbnails are produced in
# pure Go (internal/thumb/image.go) and work there; every thumbnail that shells
# out to another program needs `full`. filex probes for each tool at start
# (internal/capability) and reports what it found on /api/files/capabilities, so
# a missing one is a disabled feature with a reason, not a crash.
#
# Office documents are the exception in BOTH targets: their converter is a
# separate service (FILEX_LIBREOFFICE_URL), because bundling LibreOffice costs
# more than everything else in this file combined.
#
# Run:
#   docker run -p 5212:5212 -v $(pwd)/data:/data filex:full
#
# Multi-arch: build stages are pinned to $BUILDPLATFORM so the Node/Go work
# always runs natively on the build host; the Go stage cross-compiles via
# TARGETOS/TARGETARCH (CGO=0 makes this free). Only the runtime stages (apk
# installs) run per-target-arch, under QEMU when cross-building.
#   docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile .

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
# Runtime base — shared by both targets. Metadata lives here so neither leaf
# stage repeats it, and the binary is copied in last so a code change never
# invalidates the apk layers below.
# ---------------------------------------------------------------------------
#   ca-certificates — outbound TLS (S3, WebDAV, OIDC, update checks).
#   tzdata          — local-time rendering and scheduled jobs.
FROM alpine:3.20 AS runtime
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

# ---------------------------------------------------------------------------
# Runtime base + the programs the thumbnailer shells out to.
# ---------------------------------------------------------------------------
#   ffmpeg                 — video thumbnails (1st keyframe).
#   imagemagick            — probed as `magick`/`convert` (capability/service.go).
#   ghostscript + poppler  — PDF -> JPEG (page 1). gs preferred, pdftoppm as
#                            fallback (thumb/pdf.go).
#   rsvg-convert           — SVG rasterisation.
#   fonts                  — without them Ghostscript renders the non-ASCII text
#                            of a PDF that embeds no font as boxes.
#
# ⚠ LibreOffice is NOT here, and adding it back is a mistake that costs ~730 MB
# (libreoffice 558 MB + the openjdk17 JRE its xlsx/docx pipeline needs, 172 MB —
# measured on alpine:3.20). Office thumbnails go through a conversion SERVICE
# instead: set FILEX_LIBREOFFICE_URL at a Gotenberg-compatible endpoint, or
# turn on the `libreoffice` profile in docker-compose.yml. The local `soffice` path in
# thumb/office.go is kept only for hosts that already have it installed.
#
# This layer is most of the image size; keep it out of the slim target.
FROM runtime AS runtime-full
RUN apk --no-cache add \
        ffmpeg \
        imagemagick \
        ghostscript \
        poppler-utils \
        rsvg-convert \
        ttf-liberation \
        ttf-dejavu \
        font-noto \
        font-noto-cjk

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------
FROM runtime AS slim
COPY --from=backend-build /out/filex /usr/local/bin/filex

# Last stage = the default target of a plain `docker build`.
FROM runtime-full AS full
COPY --from=backend-build /out/filex /usr/local/bin/filex
