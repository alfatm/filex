import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

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
    timeout: 5_000,
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

  reporter: [['html', { outputFolder: 'playwright-report/app', open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1672, height: 941 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 },
    },
  ],

  webServer: {
    command: `pnpm --filter ./app exec vite --port ${PORT} --strictPort`,
    cwd: path.resolve(E2E_DIR, '..'),
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
