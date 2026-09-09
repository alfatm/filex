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

The **app** profile drives the end-user SPA (`app/`) against that same hermetic
instance — the only suite that exercises `app/src/data/http/` and its contract
with the Go handlers, which is the code a deployment actually runs:

```bash
node e2e/run.mjs app --build           # or: pnpm --filter filex-e2e test:app:live
```

It seeds one local drive (`live://`), builds `@brftech/filex-core` and the app
bundle with `VITE_FILEX_API=1`, serves the BUILD with `vite preview` (whose
`/api` proxy points at the server this run started, so the browser sees one
origin and the cookie needs no CORS), and mints the session once in
`auth.setup.ts` — the app has no login screen of its own. `--app-port <n>` fixes
the preview port; `--binary`, `--build`, `--port`, `--keep` and `--grep` work as
above. ⚠ Do not run `playwright.app.live.config.ts` by hand: it needs a server,
a seeded drive and a bundle built against them, and only `run.mjs app` arranges
all three.

⚠ **`tests/app/` and `tests/app-live/` are not duplicates.** The first drives
the in-memory mock and is the UI-contract suite; the second is the wiring suite
and is deliberately small — a handful of journeys that cannot pass unless a real
server answered. They also make OPPOSITE server choices, on purpose: see the
note under the app suite below.

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

Those are the anchors, not the whole directory: `tests/` holds **24** top-level
specs, and the rest are numbered beside the ones above — connections (`25`), S3
(`26`, `--s3` only), multi-storage routing (`70`), navigation (`75`), trash
(`76`), a second share shape (`77`), Monaco save-text (`78`), the per-verb async
endpoints (`79`), the file-type MIME matrix (`80`), capability gating (`82`),
meta routes and the markdown editor (`83`), resumable upload (`85`), the slow-
storage prepared copy (`86`), the deployment smoke (`90`, its own profile) and
the per-extension viewer audit (`100`).

`helpers/auth.ts`  → `loginAs`, `apiLogin`, `logout`
`helpers/seed.ts`  → `seedLocalStorage`, `dropStorageByName`
`fixtures/`         → small files used by upload tests

## End-user app suite, on the mock (`tests/app/`)

A second, separate config — `playwright.app.config.ts` — drives the end-user
SPA in `app/` (Vue 3, served at `/app/`). It needs no filex binary and no
login: the app runs on its in-memory mock repository, and Playwright starts
the Vite dev server itself on port 5176 (`webServer`, reused if one is already
listening there).

⚠⚠ **It needs a directory that is not in this repository.** The mock dataset
(`app/src/data/mock/tree.json`) describes a real tree of demo files kept in a
SIBLING repo, `drive-demo-assets`; `app/vite.config.ts` serves it under
`/app/demo-assets/` and only WARNS when it is missing, so without it the suite
used to fail much later and elsewhere — around seven functional tests (preview,
download, thumbnails) and all fifteen visual baselines, with messages that say
nothing about a missing checkout. The config now checks the path before a
browser starts and refuses with instructions. Clone it next to this checkout, or
point at a copy:

```bash
DEMO_ASSETS_DIR=/path/to/demo pnpm --filter filex-e2e test:app
```

`app/docs/DEMO-ASSETS.md` has the full story, including the generator that
rewrites `tree.json` from the directory.

⚠ **The dev server, and it has to be — even though the demo stand no longer uses
one.** `docker-compose.app.yml` serves a BUILT bundle (`vite preview`) on
purpose: the query hooks below live behind `import.meta.env.DEV` and would let a
stand pointed at a real filex show rows the server never sent. This suite drives
those same hooks, so it needs the build that has them. Measured rather than
assumed: serving the bundle to this suite failed 47 of 108 tests, every one of
them on a hook that is not in it. Do not "fix" one of the two by making it match
the other: `tests/app-live/` makes the opposite choice for the same reason —
against a real server the hooks could be made to assert things the server never
said, so that suite serves the build and this one serves the dev server.

```bash
cd e2e
pnpm test:app             # run the suite
pnpm test:app:ui          # Playwright UI mode
pnpm test:app:update      # retake the visual baselines
```

All eighteen of them, because a table that lists a third of a suite is how a
spec comes to be forgotten. The counts below are the mock tree's
(`app/src/data/mock/tree.json`, 8 folders and 9 files at the root, 151 entries in
all) — read them out of that file rather than off this page if you are changing
the dataset.

The specs read them out of that file too, through `helpers/mockTree.ts`
(`countIn`, `imagesIn`, `searchHits`): the "9 files", "17 rows", "8 items" and
"14 matching items" they used to spell out are counted at run time, so
regenerating the demo tree is a data change and not a dozen red tests. Dates,
stars, tags and the quota are mock *annotations* on top of the tree
(`REF_OVERRIDES` / `sharedWithMe` in `app/src/data/mock/dataset.ts`), do not
move when the assets are regenerated, and are still asserted literally.

| File | Coverage |
|------|----------|
| `tests/app/shell.spec.ts`       | the app shell: reload announcement, sidebar collapse to icons and back, New from the rail, a folder that is gone offering a retry |
| `tests/app/files-grid.spec.ts`  | sidebar nav, 8 folder + 9 file cards, Design's 8 files with real thumbnails, star badges in both views, Info toggles the details panel |
| `tests/app/files-list.spec.ts`  | list toggle, header columns, 17 rows, checkbox / selection bar / Esc, Name sort, keyboard (↑↓ Space Ctrl+A) |
| `tests/app/files-breadcrumbs.spec.ts` | the crumb chain names every folder above, each crumb navigates, the trailing chevron descends, a long chain folds its middle |
| `tests/app/files-actions.spec.ts` | New folder, Rename (collision refused), Move picker + folder filter, Move to trash + Undo, Restore, star, Move/Copy to, Share, upload through the tray and cancelling one |
| `tests/app/files-clipboard.spec.ts` | Ctrl+X/C/V through menus and keyboard, a folder refused into itself, the named copy, Ctrl+Z / Ctrl+Shift+Z, bare `R` refreshes |
| `tests/app/files-dnd.spec.ts`   | drag a file onto a folder card, a multi-selection together, a breadcrumb as a drop target, OS files dropped into the folder and onto a card |
| `tests/app/files-filters.spec.ts` | the chips above a listing: Type, People on Shared with me, Modified (the advanced-search windows), the empty result's way back, and the filter surviving navigation |
| `tests/app/files-tags.spec.ts`  | the tags modal adds and removes, search finds what it wrote, a tag left in the box counts as typed |
| `tests/app/files-history.spec.ts` | the details panel's tabs: versions listed and restored, a folder that keeps none, People (invite / change role / remove, owner row fixed), Activity |
| `tests/app/search.spec.ts`      | the topbar box runs a quick search, the sliders button opens Advanced search prefilled with live results, Search → `/search?q=…`, Cancel / Esc, and the deep link |
| `tests/app/assistant.spec.ts`   | Sparkles opens the panel, a prompt streams an answer with result cards, chats listed / renamed / dropped, a conversation named by its first question, mode chips, Esc / close |
| `tests/app/pages.spec.ts`       | Home, Recent (newest first, grouped by day), Shared with me ("Shared by" / "Shared on"), Trash (banner, Deleted / Original location, Empty trash confirm) |
| `tests/app/preview.spec.ts`     | preview modal: image → text (← →), PDF iframe, CSV table, download card, `?download=1` attachment, ⋮ / Enter, Recent order |
| `tests/app/settings.spec.ts`    | the settings modal: both ways in, Security (sign-in method, password), profile fields and notification switches, active sessions, theme, **the Language select**, compact list, display name, avatar removal |
| `tests/app/capabilities.spec.ts` | `?caps=` stands in for a narrower server: the assistant trigger hidden, actions that stay in the menu and say why, Delete forever inert |
| `tests/app/i18n.spec.ts`        | `localStorage['filex.app.locale']` = ru / tr renders the sidebar in that language, and the default comes from the browser |
| `tests/app/visual.spec.ts`      | pixel baselines for the **15** reference states of `DESIGN-SPEC.md` §2–§7 |

⚠ `i18n.spec.ts` opens with "the app has no language switcher in its UI yet".
That is out of date — the settings modal has a Language select and
`settings.spec.ts` drives it. The i18n spec writes
`localStorage['filex.app.locale']` because it needs the locale in place BEFORE
the first navigation, which is the one thing clicking the select cannot do; the
comment, not the test, is what is wrong.

Visual baselines live in `tests/app/__screenshots__/` with no platform suffix
(`snapshotPathTemplate`), at 1672×941 @1x, `en-US`, UTC — the same frame
`app/scripts/shot.mjs` uses.

⚠ There is **one** baseline set and it belongs to **one** environment: Linux
with the Chromium that the pinned `@playwright/test` (1.62.1, exact in both
`e2e/package.json` and `app/package.json`) ships — i.e.
`mcr.microsoft.com/playwright:v1.62.1-noble`. `visual.spec.ts` checks
`process.platform` and `browser.version()` in `beforeAll` and fails the whole
file anywhere else, on purpose: elsewhere a run would report the machine as a
design change, and `--update-snapshots` would quietly overwrite good baselines
with that machine's rendering. A suffixed-per-platform set was the alternative
and is worse here — every Playwright bump would add another 3.7 MB of PNGs
beside the ones it replaces, forever. To run the rest of the app suite off that
platform: `pnpm test:app --grep-invert "reference state:"`. When the pinned
Playwright version moves, retake all fifteen baselines and update
`BASELINE_CHROMIUM` in the same commit. The tolerance is `maxDiffPixels: 50` and nothing
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

The app reaches its reference states through screenshot-only query hooks, which
`app/src/dev/screenshotQuery.ts` defines and a production build does not carry:
`?view=list|grid`, `?select=<name>`, `?panel=details|assistant|none`,
`?modal=search|settings|rename|preview`, `?menu=item`, `?theme=light|dark|system`,
`?filter=type:images`, `?caps=assistant:0,tags:1`, `?demo=assistant|trash`.

`visual.spec.ts` is where they express a design state, but it is **not** the only
spec that uses them: seven functional specs use them as SETUP, to reach a
starting position without a click sequence — `capabilities` (`?caps=`, `?demo=`),
`pages` (`?demo=trash`), `preview` (`?modal=preview&select=`), `files-actions`,
`files-clipboard`, `files-dnd` and `files-filters` (`?view=list`, `?select=`,
`?panel=`). What none of them do is use a hook as the thing under test: the
behaviour a spec asserts is always reached the way a user reaches it.

⚠ `baseURL` ends in `/app/`, so specs navigate with `page.goto('files')`, not
`page.goto('/files')` — a leading slash resolves against the origin and drops
the prefix.

The admin config ignores `tests/app/**` and `tests/app-live/**`, and `run.mjs`
only lists top-level spec files, so neither the harness nor a bare `pnpm test`
picks these up.

## End-user app suite, against a real server (`tests/app-live/`)

`playwright.app.live.config.ts`, started by `node e2e/run.mjs app --build` (see
above). `auth.setup.ts` mints the session once through the preview server's own
origin; `files.spec.ts` walks the journeys that cannot pass unless a real server
answered — the shell booting with none of the mock dataset on screen, New folder
surviving a reload, a duplicate name refused with the first folder intact,
upload landing real bytes, rename moving the file on the server (and a collision
refused with neither file moved), trash and restore travelling through the
server rather than the store, and Download handing back the bytes that went up.

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
