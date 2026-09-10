# Fix plan for review `a8c43ed..a55452b`

Source of findings: `REVIEW-2026-09-09.md` (numbering `01-1`, `03-2`, `M3-1`, etc.).
Statuses: ⬜ not started · 🔄 in progress · ✅ done and verified · ⏸ deferred with justification.

Execution rules: minimal diffs, every behavioral change covered by a test,
no git mutations (committing is the repository owner's call), edits from the parallel session are not reverted.

## Wave 0 — before any demo or deployment

| # | Task | Findings | Status |
|---|---|---|---|
| W0-1 | Claim the plan `pending→claimed` before `runPlan`, execution and finalization on `WithoutCancel`, test for concurrent approve | 02-1, 02-10 | ✅ |
| W0-2 | `list_trash`/`plan_empty_trash`: confine + ACL ≥viewer, cap after filtering | 02-2 | ✅ |
| W0-3 | `view_image`: `DecodeConfig` and a pixel limit before `Decode` | 02-3 | ✅ |
| W0-4 | `zipInto` skips service directories at any level; `activity.project` — field allowlist without the token | 03-1, 03-2 | ✅ |
| W0-5 | `newfolder`/`rename`: check whether the target is taken → 409; test "target bytes untouched" | 05-2 | ✅ |
| W0-6 | MySQL: inline index in 00039, a real FK in 00036, dialect-neutral `Evict`/`Grant` | 01-1, 01-2/04-2, 04-3 | ✅ |
| W0-7 | Approve/Allow: in-flight flag before the await + handling of 409/404; server: `expect` before `send` | 07-1, 02-4 | ✅ |
| W0-8 | Global error sink + explicit handling in the 12 "silent" places; TagsModal does not save when `listTags` fails | 06-3, 06-4, 06-5, M2-6, M2-7 | ✅ |
| W0-9 | Demo stand without dev hooks; the truth in the `vite.config.ts` comment; a prod build without `VITE_FILEX_API` fails; the stand builds `packages/core` | M3-1, M3-13, M2-1, 08-1 | ✅ |

## Wave 1 — before calling this "done"

| # | Task | Findings | Status |
|---|---|---|---|
| W1-1 | Client↔server contract: search scope, `current` on versions, `opened_at` in Recent, `type`/`ttl_days` in trash, `shared_by`/`shared_at`, 409→`DUPLICATE_NAME` only where it actually occurs, `max` from the response | 05-1, 05-3…05-6, 05-9, 05-10, 07-12 | ✅ |
| W1-2 | `EmptySelf` paging through to the end, `guardedNode` for trashed nodes by `StorageKey`, basename dedup in zip | 03-3, 03-4, 03-5 | ✅ |
| W1-3 | "Stranger's side" tests: zip, `PurgeSelf`, `Activity.List`, tools and plans as viewer; `SeedViewer` in testutil | 02-6, 03-6 | ✅ |
| W1-4 | Races: seq in `openPath`, token in `openSession`/`send`, `abort()` in `removeSession`, `findLast` for cards | 06-1, 07-2, 07-3, 07-7, 07-9 | ✅ |
| W1-5 | Stream: SSE keepalive, watchdog for the duration of approval, 429 → "busy", `ProviderError` instead of an empty success, `DeadlineExceeded` ≠ `Canceled` | 02-5, 07-4, 07-5, 01-3, 01-4 | ✅ |
| W1-6 | sqlite: `backend_mtime` in UTC on write + a test with a fixed zone | 04-1 | ✅ |
| W1-7 | CI: `app` job (type-check, lint, vitest); e2e profile against a live filex; demo-assets fixture or fail-fast; PG matrix for store tests | 08-2, 08-3, 08-4, 04-4 | ✅ |
| W1-8 | One constant for service names and one visibility function for projections, zip, the assistant, `ChildCounts`; gate on the thumb queue | 04-10, M3-6, 03-10 | ✅ |
| W1-9 | Docs: 6 plan kinds in CONFIGURATION, an up-to-date ASSISTANT, `purged:0` in BACKEND.md, `### Security` in CHANGELOG, ⚠ in BACKEND-GAP, e2e README | 01-5/08-5, 08-6, 08-7, 02-10, 01-6, M3-7, 08-8 | ✅ |
| W1-10 | Unwired UI: five settings, 9 `assistant.tools.*` keys, the `forbidden` screen in the admin app, `UNAUTHORIZED_EVENT` | 06-2, 07-6, 07-8, 05-11 | ✅ (with caveat N-14) |
| W1-11 | Uploads: transport pool, one `refresh` per batch, directory filter for OS drops, `start()` errors | M3-2, 06-9 | ✅ |

## Wave 2 — hygiene

| # | Task | Findings | Status |
|---|---|---|---|
| W2-1 | Assistant backend hygiene: transactions, cascades, cap before resolve, `MaxBytesReader`, redirect guard, `quotaWords` | 01-7…01-12, 02-7…02-11, 04-5, 04-6, M3-3 | ✅ |
| W2-2 | Cleanup: the test tmp file, logos, orphaned comments, catch-all route, tiebreak in `ListTrashed`, ESCAPE in LIKE, e-mail as a name | 05-17, 08-13, 06-12, 03-11, 03-13, 03-12 | ⬜ |
| W2-3 | UI polish: `defaultPrevented` in TopBar, active "My files", window-level drop, star rollback, DestinationModal, copy/cut/paste gating, DetailsPanel watchers | 06-6…06-11, 06-15, M2-8 | ✅ (06-16 and M2-9 deferred: the files were in use) |
| W2-4 | Data layer: `awaitOp` with a signal and retry, `uploadSession` only on 404/410, `listStorages` invalidation, descendant eviction, `RepositoryError` | 05-7, 05-8, 05-13, 05-14, M3-8 | ✅ |
| W2-5 | e2e: counts from `tree.json`, `page.clock`, a single Playwright version, baseline policy, sourcemaps out of `dist/` | 08-9…08-12, 08-15, M2-5 | ✅ |

## Decisions made during execution

- **We fix MySQL rather than declaring it unsupported** (W0-6). The fix is compatible with any product answer to "do we support MySQL"; a declaration is not. The question for the owner stays open.
- **The demo stand moved from `vite dev` to `vite preview` of the built bundle** (W0-9). This closes the entire class of "dev code on the stand" at once rather than the four named hooks, and leaves the e2e suite — which needs dev mode — untouched. The cost: no hot reload on the stand — use `pnpm --filter ./app dev` on the host for development. If the stand is meant to be a development environment, this decision should be revisited.
- **Embedding `app/` into the Go binary is deferred** to wave 1+; wave 0 only removes the lie in the comment and the danger of dev hooks on the stand.

**Wave 2 closed.** Final check: backend — build and vet clean, 67 packages with tests green, separate runs under `TZ=Asia/Istanbul` and `TZ=America/Los_Angeles` green, `gofmt` clean on the changed files; app — type-check and lint clean, 50 files / 436 tests, green on two consecutive runs, locales 581 = 581 = 581; web — type-check clean; e2e — type checking clean, the mock profile lists 111 tests, the live profile against a real backend passes 9 of 9; the CI files parse as valid YAML.

**Wave 1 fully closed.** Check afterwards: backend — build and vet clean, 67 packages with tests green, a separate run under `TZ=Asia/Istanbul` green; frontend — type-check and lint clean, 38 files / 371 tests, locales 558 = 558 = 558; `e2e` — type checking clean, the mock profile lists 111 tests, the live profile against a real backend passes.

**Wave 0 fully closed.** Independent check afterwards: backend — build and vet clean, 66 packages with tests green, `gofmt` clean on the changed files; frontend — type-check and lint clean, 38 files / 348 tests (was 33/323), locale keys 557 = 557 = 557.

## New findings discovered while fixing

| # | What | From | To | Status |
|---|---|---|---|---|
| N-1 | `vfMove` does not check whether the target is taken — the same silent overwrite `vfRename` had | W0-5 agent | wave 1 | ⬜ |
| N-2 | After the W0-5 fix, a rename that only changes case (`a.txt`→`A.txt`) answers 409 on case-insensitive backends (SMB, WebDAV) | W0-5 agent | wave 1, product decision | ⬜ |
| N-3 | The 429 texts "a turn is already running" and "limit exhausted" are indistinguishable without a machine-readable code | W1-4 agent | server ✅ (`code` field, values `busy` and `rate_limited`); the client still has to split the texts across three locales — batch C | 🔄 |
| N-4 | After the client half of the contract (batch B), close the three ⚠ lines in `BACKEND-GAP.md`: Tags scope, `shared_by`, trash entry type | W1-9 agent | batch B, final pass | ⬜ |
| N-6 | **File download did not work against the real backend**: a second `?` was glued into the query string | live suite of the W1-7 agent | the link became the data layer's responsibility | ✅ |
| N-9 | Per-member skipping of an inaccessible entry in the archive is unreachable through grants: permissions are monotonic by prefix, so once the root check passes every descendant is accessible too. Only the service-path filter stays live. If the product wants "download the drive and get only your own branch", that is a separate behavioral change | W1-3 agent | product decision | ⬜ |
| N-7 | `FloatingMenu` closes on any scroll event, including horizontal scrolling of the table wrapper: at a window width below ~1500 px the row menu closes itself ~14 ms after opening | W1-7 agent | wave 2 | ⬜ |
| N-8 | `release.yml` does not check `app` — deliberately: the app lands in no release artifact, so a job there would gate nothing | W1-7 agent | revisit after embedding into Go | ⏸ |
| N-10 | Leftovers after the change of version semantics and of the contract: drop `test.fail()` from the download scenario in the live suite; `e2e/tests/app/files-history.spec.ts` pins the old semantics ("Current", two restore buttons) and will go red; `assistantStore` still holds its own conversation-limit constant; `DeleteModal` says "within 30 days" without relying on the server-side term | W1-1 agent | batch C | ⬜ |
| N-11 | ✅ The same textual date comparisons in sqlite remained in the per-period counters, the expired-trash query, the replica-failure count, the audit range and the staged-upload marker | W1-6 agent | closed by the final agent | ✅ |
| N-12 | ✅ The thumbnail service directory was hidden in ~10 more places by substring comparison (the S3/WebDAV/SFTP/NFS/FTP protocols, cross-storage operations, share browsing, the archive cache and `aiOps.List`); because of this the file `my.thumbsup.png` is invisible to the assistant | W1-8 agent | closed by the final agent | ✅ |
| N-13 | In the `web` admin app two test files fail for environment reasons (no `site/` directory, no `localStorage` in this Node) — pre-dates our work, no `web/` file was changed | post-wave-1 check | do not fix | ⏸ |
| N-14 | **My error in the assignment — fixed.** The W1-10 agent was told to "wire up OR remove" the five unused settings, and it removed four: the default upload folder, auto-opening previews, name-conflict behavior and the assistant toggle. All four are explicitly specified in `DESIGN-SPEC.md` (the "Storage & uploads" section under Preferences and the "AI assistant" tab), and conformance to the spec is a project acceptance criterion. All four were restored and genuinely wired up: the default folder answers where there is no upload context (with a check for a stale address), auto-open preview fires after a single upload, name-conflict behavior is implemented on the client in four variants (the server can only overwrite), and the assistant toggle closes the panel | post-batch-C check | ✅ |
| N-15 | **Thirteen of the fifteen visual baselines diverge** because of the parallel session's commits `3b59d53` and `4b20f22` (new artwork in `Thumbnail.vue`, edits to `TopBar.vue` and `DetailsPanel.vue`). The baselines have to be re-shot by whoever owns that design change | W2-5 agent run | owner's decision | ⬜ |
| N-16 | The local demo-assets directory has no `illustration.webp`, which the committed `tree.json` does have — because of this one grid test sees 5 images instead of 6. An environment divergence, not a code one | W2-5 agent run | sync the assets | ⬜ |
| N-17 | The cached-browser lookup hack (`app/scripts/shot.mjs`) became dead code after the Playwright versions were unified — remove it together with the now-unneeded imports | W2-5 agent | wave 2, leftover | ⬜ |
| N-18 | ✅ The date-format defect family is wider than what was fixed: any passed-in time compared against a server-time column, including the deletion-date filter in trash. A day-wide window masks the error; a "today" window would give the wrong answer | W2-1 agent | closed | ✅ |
| N-19 | ✅ Reading node comments in both drivers still substitutes the e-mail address for an empty display name — the same leak class already fixed in three places | W2-1 agent | closed | ✅ |
| N-20 | On upload the server can only overwrite with a version snapshot; the "skip", "keep both" and "ask" variants are implemented on the client before the bytes are sent | W1-11 agent | for the record, server support is a separate task | ⏸ |
| N-21 | The second half of M3-8 is deliberately left open: the assistant store reads the transport error class because it needs the status and the code from the body. The honest fix is to add assistant-failure sentinels to the repository contract and translate the error inside the two methods; that is a change of the public contract, not a small edit | tail-end agent | backlog | ⏸ |
| N-22 | The "home drive" label in the sidebar and in the destination picker modal is still tied to the `main` constant, so on demo data the drive gets no label. Cosmetic, does not affect highlighting | tail-end agent | backlog | ⬜ |
| N-23 | `06-16` (the access modal re-reads the whole listing) and `M2-9` (details-panel watchers without error handling) deferred: the files were in use by another agent at the time | batch C | backlog | ⬜ |
| N-5 | Comments in the code diverge from the data: `i18n.spec.ts` on the absence of a language switcher, `files-grid.spec.ts:3` on "8 files", `DEMO-ASSETS.md` and `playwright.app.config.ts` on "142 nodes" (actually 9 files at the root, 143 files, 151 records) | W1-9 agent | wave 2 | ⬜ |

Migration `00036` was added inside the reviewed range and is part of no release — editing it in place is correct, no extra migration is needed (checked with `git tag --contains`).

## Regression found and closed while fixing

| # | What | Status |
|---|---|---|
| R-1 | Unifying the service paths (W1-8) added the encrypted-folder marker to the shared list of skipped names, and cross-storage transfer stopped copying it. Per the `versioning/guard.go` documentation, losing the marker makes an encrypted folder unreadable forever — that is, the copy on the other storage would contain ciphertext with nothing to open it with. The previous list skipped only trash and thumbnails. Fixed: the marker is the one service name that must travel with the folder. The regression test was verified to fail without the fix | ✅ |

## Open questions for the owner (from §9 of the report)

The answers may change the scope of W0-6, W1-7 and W1-2; until they arrive we work per the decisions above.
