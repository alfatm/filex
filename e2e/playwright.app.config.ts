import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(E2E_DIR, '../app');

/**
 * ⚠ This suite needs a directory that is NOT in this repository.
 *
 * The mock dataset (`app/src/data/mock/tree.json`) describes a real tree of demo files that lives in a SIBLING
 * repository, `drive-demo-assets`; `app/vite.config.ts` serves it under `/app/demo-assets/` and only warns when it
 * is absent. That warning scrolls past in the Vite output and the suite then fails much later and elsewhere: ~7
 * functional tests (preview, download, thumbnails) and all 15 visual baselines go red with "expected 2 links, got
 * 0", "screenshot comparison failed" and other messages that say nothing about a missing checkout.
 *
 * So it is checked HERE, before a browser is started, and the resolution rule is copied from vite.config.ts
 * verbatim (`DEMO_ASSETS_DIR`, else `../../drive-demo-assets/demo` relative to `app/`) — the two must agree or the
 * check would pass for a directory the dev server never reads. app/docs/DEMO-ASSETS.md has the full story.
 */
const DEMO_ASSETS_DIR = path.resolve(APP_DIR, process.env.DEMO_ASSETS_DIR ?? '../../drive-demo-assets/demo');
if (!existsSync(DEMO_ASSETS_DIR)) {
  throw new Error(
    `the app e2e suite needs the demo assets, and there is nothing at:\n  ${DEMO_ASSETS_DIR}\n\n` +
      `They are not part of this repository. Either:\n` +
      `  • clone the sibling repo next to this checkout, so the default path resolves:\n` +
      `      git clone <drive-demo-assets> ${path.resolve(APP_DIR, '../..')}/drive-demo-assets\n` +
      `  • or point at a copy you already have:\n` +
      `      DEMO_ASSETS_DIR=/path/to/demo pnpm --filter filex-e2e test:app\n\n` +
      `Without them the mock repository still lists its 142 nodes, but every file's bytes 404: previews, ` +
      `downloads and thumbnails have nothing to show and all 15 visual baselines mismatch. See ` +
      `app/docs/DEMO-ASSETS.md.`,
  );
}

/**
 * Playwright config for the END-USER SPA (`app/`, served at /app/).
 *
 * Kept apart from `playwright.config.ts` on purpose: the admin suite needs a
 * filex binary, an admin login and a single worker over a shared SQLite DB;
 * this one drives the app against its in-memory mock repository, so it needs
 * no backend, no login and can run in parallel. Playwright starts the Vite
 * dev server itself (`webServer`) and reuses one you already have on :5176.
 *
 *   pnpm --filter filex-e2e test:app            # run
 *   pnpm --filter filex-e2e test:app:ui         # UI mode
 *   pnpm --filter filex-e2e test:app:update     # refresh visual baselines
 *
 * ⚠ baseURL ends in `/app/`. Navigate with `page.goto('files')`, NOT
 * `page.goto('/files')`: a leading slash resolves against the origin and
 * drops the `/app` prefix, which the dev server answers with an empty page.
 *
 * Viewport, scale factor, locale and timezone are pinned because the visual
 * baselines in `tests/app/__screenshots__/` are compared pixel-for-pixel
 * against the reference states in `app/docs/DESIGN-SPEC.md` (1672×941 @1x,
 * same frame `app/scripts/shot.mjs` uses). The app picks its language from
 * `navigator.language` when nothing is stored, and formats dates in the
 * browser's zone, so both must be fixed for the run to be deterministic.
 */
const PORT = 5176;
const BASE_URL = `http://localhost:${PORT}/app/`;

export default defineConfig({
  testDir: './tests/app',
  outputDir: 'test-results/app',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    // 50 pixels, not a ratio. 0.002 of this 1672×941 frame is 3147 px, and Playwright counts only pixels that
    // differ perceptibly (pixelmatch, threshold 0.2), so real design changes score far below that: enabling two
    // greyed menu entries and swapping one icon measures 234 px — thirteen times under the old ceiling, which is
    // why it passed against a stale baseline in silence, as a 44px button and a new sidebar logo had before it.
    // Comparison is bit-exact on a pinned viewport, scale, locale, timezone and disabled animations (six
    // consecutive runs at maxDiffPixels: 0 found nothing), so this allowance is headroom for a font or Chromium
    // update, not for the app's own pixels.
    toHaveScreenshot: { maxDiffPixels: 50, animations: 'disabled', caret: 'hide' },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  // ⚠ Four, not Playwright's default half-the-cores.
  //
  // Measured on a 14-core machine, same commit, same suite, back to back at the
  // same load:
  //
  //   workers 7 (the old default)   77 s, 77 s — and the second run failed
  //   workers 4 (this)              22 s, 22 s, 21 s, 22 s, 22 s — all green
  //
  // Fewer browsers is not a trade of speed for stability here; it is faster AND
  // stable, because seven Chromiums plus a Vite process on one box is
  // oversubscription and everything then waits on everything. The same config
  // that failed at load average ~23 passed 108/108 in 20 s at load ~2, which is
  // the whole flakiness story this suite has had: not a product bug, not a bad
  // selector, a browser count tuned for an idle machine.
  workers: process.env.CI ? 2 : 4,

  reporter: [['html', { outputFolder: 'playwright-report/app', open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1672, height: 941 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Headroom for a loaded machine, not for a slow app: every one of these
    // tests drives an in-memory mock repository, so anything past a few hundred
    // milliseconds is the machine, and reporting the machine as a product
    // failure is what these numbers are here to stop.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 },
    },
  ],

  // ⚠ The dev server, and it has to be: the screenshot/e2e query hooks this
  // suite drives (`?panel=assistant`, `?modal=preview`, `?demo=…`) live behind
  // `import.meta.env.DEV` and are deliberately absent from a build. Serving the
  // build from `vite preview` was measured rather than assumed: 47 of 108
  // failed, every one of them on a hook that is not in the bundle.
  //
  // ⚠⚠ `reuseExistingServer` reuses ANY server that answers on this port, not
  // only this app's. A stray dev server from another package that has drifted
  // onto 5176 will be tested instead, and every failure it produces is a lie.
  // If results look impossible, check what is actually listening.
  webServer: {
    command: `pnpm --filter ./app exec vite --port ${PORT} --strictPort`,
    cwd: path.resolve(E2E_DIR, '..'),
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
