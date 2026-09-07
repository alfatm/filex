# filex — E2E test suite

End-to-end tests powered by [Playwright](https://playwright.dev). They
drive the same Vue 3 admin UI a real user sees, against a running
`filex` HTTP server.

## Prerequisites

- Node 20+, pnpm 9+
- Docker (for the most repeatable run, but not strictly required)

## Run locally

One command. It starts a filex binary on a free port against a throwaway data
dir with a deterministic admin, waits for `/healthz`, runs the suite, and tears
everything down again:

```bash
cd e2e && pnpm install && pnpm install:browsers   # once
node e2e/run.mjs local --build                     # from the repo root
```

Drop `--build` once you have a binary in `bin/`, or point at one with
`--binary <path>`. Other flags:

| Flag | What it does |
|---|---|
| `--s3` | also starts MinIO in Docker, creates a bucket and registers an `s3` storage, then runs `26-s3-storage.spec.ts` against it |
| `--keep` | leaves the server (and the data dir) up afterwards so you can poke at it |
| `--port <n>` | fixed port instead of a free one |
| `--grep <pattern>` | passed through to Playwright |

The **cypress** profile starts the same kind of instance and drives
`web/cypress` instead. The two suites are not duplicates — Playwright walks
journeys, Cypress pins the HTTP contracts and the admin screens that read them
(`web/cypress/README.md` has the split, and `docs/CONTRIBUTING.md` has the "which
one do I add a test to" table):

```bash
node e2e/run.mjs cypress                # every spec
node e2e/run.mjs cypress --spec "cypress/e2e/14-explorer-sidenav.cy.ts"
```

It seeds one deterministic local storage before running. ⚠ That seed is not a
nicety: a bare instance has zero storages, and most Cypress specs discover "the
first storage" and then quietly assert nothing when there is none — a green run
that measured almost nothing.

The **deployment** profile is a separate, read-only smoke against something
already live, and is deliberately not part of a build check:

```bash
node e2e/run.mjs deployment --url https://fm.example.com
```

⚠ Keep the two apart. `90-deployment-smoke.spec.ts` talks to production, so a
run that mixes it into the local suite goes red when production is slow — which
means it can no longer answer the only question a pre-release run exists to
answer: *is this build good?*

⚠ **There is no `FILEX_E2E_BOOTSTRAP` env var.** This file and
`playwright.config.ts` both documented one for a long time; the binary has never
read it. Use `FILEX_ADMIN_EMAIL` / `FILEX_ADMIN_PASSWORD` (which is what
`run.mjs` does).

⚠ Use `127.0.0.1`, not `localhost`: on Windows `localhost` resolves to `::1`
first, and a server bound to `127.0.0.1` answers that with `ECONNREFUSED` —
indistinguishable from a server that failed to start.

⚠ **Never give the server's stdout to a Node pipe.** `run.mjs` hands the child
a file descriptor (`stdio: ['ignore', logFd, logFd]`). The obvious alternative
— `'pipe'` plus `child.stdout.pipe(writeStream)` — deadlocks the server: the
suite runs under `spawnSync`, which blocks Node's event loop, so nothing drains
the pipe, the 64 KiB OS buffer fills, and filex (one log line per HTTP request,
written from inside the request path) blocks forever in `write(2)`. Measured:
551 requests served, then dead to everything including `/healthz` for the rest
of the run — 20 specs failing with connection timeouts that look exactly like a
product deadlock. `tests/01-harness.spec.ts` guards both the mechanism and the
call.

⚠ **A storage's root is `config.path`.** Not `mount_path`, and not
`config.root` when `config.path` is also set — `local.Driver.Init` reads `path`
first. `helpers/seed.ts` used to send `{root: mountPath, path: 'fileman'}`, so
every storage every spec created resolved to the same `./fileman` directory
under the server's working dir and specs read each other's files. Use
`seedLocalStorage`, which asserts the server stored the root you asked for.

`pnpm test:ui` opens the Playwright UI mode for stepping through tests
visually. `pnpm test:debug` opens the inspector.

## Test layout

| File | Coverage |
|------|----------|
| `tests/00-smoke.spec.ts`    | server up, healthz, capabilities, login page renders |
| `tests/10-login.spec.ts`    | bad creds rejected, good creds land on dashboard, logout |
| `tests/20-storage.spec.ts`  | UI flow to add a local storage + verify in dashboard |
| `tests/30-files.spec.ts`    | upload fixture, soft-delete to trash, restore from trash |
| `tests/40-share.spec.ts`    | share token + public viewer with PIN |
| `tests/50-search.spec.ts`   | admin search/index stats + rebuild button |
| `tests/60-profile.spec.ts`  | locale switch, password change, TOTP enroll |
| `tests/01-harness.spec.ts`  | the harness itself: no piped server log, isolated storages |
| `tests/91-rounds-…`         | round 4-8 regressions; seeds its own fixture set locally, or point at a live one with `E2E_FIXTURE_STORAGE` |

`helpers/auth.ts`  → `loginAs`, `apiLogin`, `logout`
`helpers/seed.ts`  → `seedLocalStorage`, `dropStorageByName`
`fixtures/`         → small files used by upload tests

## End-user app suite (`tests/app/`)

A second, separate config — `playwright.app.config.ts` — drives the end-user
SPA in `app/` (Vue 3, served at `/app/`). It needs no filex binary and no
login: the app runs on its in-memory mock repository, and Playwright starts
the Vite dev server itself on port 5176 (`webServer`, reused if one is already
listening there).

```bash
cd e2e
pnpm test:app             # run the suite
pnpm test:app:ui          # Playwright UI mode
pnpm test:app:update      # retake the visual baselines
```

| File | Coverage |
|------|----------|
| `tests/app/files-grid.spec.ts`  | sidebar nav, 8 folder + 8 file cards, select "Design", Info toggles the details panel |
| `tests/app/files-list.spec.ts`  | list toggle, header columns, 16 rows, checkbox / selection bar / Esc, Name sort, keyboard (↑↓ Space Ctrl+A) |
| `tests/app/search.spec.ts`      | Ctrl+K → Enter opens Advanced search prefilled, live results with `<mark>`, Search → `/search?q=…`, Cancel / Esc |
| `tests/app/assistant.spec.ts`   | Sparkles opens the panel, suggestion streams an answer, mode chips, Esc / close |
| `tests/app/i18n.spec.ts`        | `localStorage['filex.app.locale']` = ru / tr renders the sidebar in that language |
| `tests/app/preview.spec.ts`     | preview modal: image → text (← →), PDF iframe, CSV table, download card, `?download=1` attachment, ⋮ / Enter, Recent order |
| `tests/app/visual.spec.ts`      | pixel baselines for the four `DESIGN-SPEC.md` reference states |

Visual baselines live in `tests/app/__screenshots__/` with no platform suffix
(`snapshotPathTemplate`), at 1672×941 @1x, `en-US`, UTC — the same frame
`app/scripts/shot.mjs` uses. The tolerance is `maxDiffPixels: 50` and nothing
is masked, so a font, scrollbar or Chromium change shows up as a diff: look at
the report before running `test:app:update`, and commit a refreshed baseline
only with the design change that caused it.

Two traps this tolerance used to hide. It was a ratio, 0.002 — 3147 px of this
frame — while Playwright counts only pixels that differ perceptibly, so real
design changes land far below it: enabling two greyed menu entries and swapping
an icon measures 234 px, thirteen times under that ceiling. A 44px button, the
sidebar logo and a whole extra menu row each passed against a stale baseline in
silence. And `--update-snapshots` defaults to `changed`, which rewrites nothing
a passing comparison never flagged, so the stale baseline survived the refresh
too. Comparison itself is bit-exact here (the viewport, scale, locale, timezone
and animations are all pinned), so a diff in the hundreds of pixels is a real
change, not noise. Note that update mode takes a single shot instead of waiting
for two identical ones, so `--update-snapshots=all` can capture a transient
frame: check what it wrote before committing it.

The app reaches its reference states through screenshot-only query hooks
(`?select=Design`, `?view=list|grid`, `?panel=details|assistant`,
`?modal=search|rename|preview`, `?demo=assistant`); the visual spec is the only place that
should use them — the functional specs drive the UI the way a user does.

⚠ `baseURL` ends in `/app/`, so specs navigate with `page.goto('files')`, not
`page.goto('/files')` — a leading slash resolves against the origin and drops
the prefix.

The admin config ignores `tests/app/**`, and `run.mjs` only lists top-level
spec files, so neither the harness nor a bare `pnpm test` picks these up.

## Screenshots (`shots/`)

`shots/capture.mjs` retakes every screenshot the project README shows — in
English, against the build in this working tree. Reviewing them is a numbered
step in the release process (`docs/CONTRIBUTING.md`): a stale screenshot is
wrong information, not missing information.

```bash
pnpm run build:all              # the shots come from this binary
node e2e/shots/capture.mjs      # → docs/screenshots/*.png
```

It boots its own instance, generates the demo tree (`shots/fixtures.mjs` — PNGs
encoded with Node's zlib, no image dependency), signs in and captures. Useful
environment variables:

| Variable | Why |
|---|---|
| `FILEX_BIN` | binary to run (default `bin/filex`) |
| `SHOTS_URL` | shoot an instance that is ALREADY running instead of booting one |
| `SHOTS_STORAGE` / `SHOTS_MOUNT` | the fixture directory as *this machine* and as the *server* see it — they differ when the server runs in a VM / WSL / container |
| `SHOTS_SEED_ONLY`, `SHOTS_SKIP_SEED` | two passes: seed, run `filex thumb backfill` out of band, then capture. Thumbnails are rendered on UPLOAD, so fixtures written straight to disk have none and the hero shot comes out as a grid of generic icons |
| `SHOTS_DEMO` | capture `demo-landing.png` — needs an instance booted with `FILEX_DEMO_MODE=true`, because that page replaces the login screen |
| `SHOTS_PLUGIN_BIN` | an already-built `examples/plugin-memfs` binary for the shots machine. Normally unnecessary: when `go` is not on the PATH the script cross-builds the plugin **through WSL**. ⚠ A path that is set and wrong is an error, not a shrug |
| `SHOTS_ALLOW_SKIP` | permit a deliberate partial run. ⚠ Without it, **a shot the script was asked for and could not take fails the run** — that is the point: `admin-plugins.png` sat outdated for several releases behind a script that logged one line, skipped it and exited 0, and a release step that reports success while leaving the old file in place is not a gate |
| `SHOTS_KEEP` | leave the instance running afterwards |

## Notes

- Tests are **serialized** (`workers: 1`) because the backend is
  single-tenant and shares a single SQLite DB across the run.
- `E2E_AUTOSTART=1` makes Playwright spin the Docker image up itself
  via `webServer` config — used in CI.
- Skips must be **measured and explained**, never a hedge. A skip whose
  condition can no longer become false is a deleted test with extra steps:
  60-profile skipped its locale and password cases on every run for as long as
  anyone looked, because it matched `/old password/` against a field labelled
  "Current password". If you write `test.skip`, the reason string has to name
  the thing that is missing (`rsvg-convert is not on PATH here`) so a reader
  can tell "this machine can't" from "this build is broken".
- Environment-dependent cases gate on the capability probe, not on a hostname:
  OnlyOffice (`external.onlyoffice.state`), SVG thumbnails
  (`thumbs.svg` / rsvg-convert), office thumbnails (`libreoffice`), S3
  (`--s3`). On a host with those installed they become real assertions with no
  code change.

## CI

The `test:e2e` job in `.gitlab-ci.yml` (rules: optional,
`allow_failure: true` initially) runs the suite against the freshly
built Docker image on tag pushes.
