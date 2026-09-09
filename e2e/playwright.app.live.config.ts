import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(E2E_DIR, '../app');

/**
 * Playwright config for the END-USER SPA against a REAL filex server.
 *
 * The third suite in this directory, and the only one that measures the code that ships:
 *
 *   playwright.config.ts        admin SPA + HTTP contracts, real backend  (node e2e/run.mjs local)
 *   playwright.app.config.ts    app/, in-memory mock repository            (pnpm --filter filex-e2e test:app)
 *   THIS ONE                    app/, real backend, built bundle           (node e2e/run.mjs app --build)
 *
 * Why it exists: every spec in `tests/app/` drives `app/src/data/mock/`, so the one module that a deployment
 * actually runs — `app/src/data/http/`, and its contract with the Go handlers — had no end-to-end coverage at all.
 * The mock suite is not redundant; it is the UI-contract suite, and it stays. This one is the wiring suite, and it
 * is deliberately small: a handful of journeys that cannot pass unless a real server answered.
 *
 * ⚠ Do NOT run this config by hand. It needs a server, a seeded drive and a bundle built against them, and
 * `run.mjs app` is the one thing that arranges all three (a throwaway data dir, a deterministic admin, a free
 * port, and teardown). The guards below refuse rather than run something meaningless.
 *
 * ⚠ The BUILT bundle over `vite preview`, never the dev server — the opposite of the mock suite's choice, and for
 * the same reason. `app/src/dev/screenshotQuery.ts` monkeypatches the repository, forges capabilities and posts
 * mock rows; it is behind `import.meta.env.DEV`, so a dev server pointed at a real backend can be made to assert
 * things the server never said. A build has none of it. `docker-compose.app.yml` serves the stand the same way.
 *
 * ⚠ baseURL ends in `/`, as in the mock suite: navigate with `page.goto('files')`, not `page.goto('/files')`.
 */

/** Where `vite preview` will serve `app/dist`. run.mjs picks a free one; 5178 is the bare-hands default. */
const PORT = Number(process.env.E2E_APP_PORT) || 5178;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

/** The filex server this run talks to. `vite.config.ts` reads the same variable to point the preview proxy at it. */
const API_PROXY = process.env.FILEX_API_PROXY;

const HOW = 'Run:  node e2e/run.mjs app --build';

if (!API_PROXY) {
  throw new Error(`FILEX_API_PROXY is not set: there is no server for this suite to talk to.\n${HOW}`);
}
if (!process.env.E2E_APP_STORAGE) {
  throw new Error(
    `E2E_APP_STORAGE is not set: the specs address every node as "<drive>://path" and cannot guess the drive.\n${HOW}`,
  );
}
if (!existsSync(path.join(APP_DIR, 'dist', 'index.html'))) {
  throw new Error(
    `there is no build at ${path.join(APP_DIR, 'dist')}: \`vite preview\` would serve nothing.\n` +
      `The bundle also has to be built with VITE_FILEX_API set, or it ships the mock repository and this\n` +
      `whole suite would measure demo data.\n${HOW}`,
  );
}

/** Cookies for the deterministic admin, minted once by `tests/app-live/auth.setup.ts`. */
const AUTH_STATE = path.join(E2E_DIR, 'test-results', 'app-live', 'auth.json');

export default defineConfig({
  testDir: './tests/app-live',
  outputDir: 'test-results/app-live',
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // ⚠ Serial, single worker. One server, one drive, one admin account: these specs create, rename and trash real
  // rows in a shared tree, and the admin suite next door carries the same note for the same reason.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [['html', { outputFolder: 'playwright-report/app-live', open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    // ⚠ The app's design width, the same frame the mock suite pins — not Playwright's 1280×720 default.
    //
    // The file table sits in an `overflow-x-auto` wrapper, and below ~1500 px it genuinely overflows. Opening a
    // row's ⋮ menu then focuses inside it, the browser scrolls that wrapper a few pixels to bring the focused
    // control into view, and `FloatingMenu` closes on ANY scroll (`window.addEventListener('scroll', close, true)`)
    // — so every menu shut itself a dozen milliseconds after opening. Measured: `scroll target=DIV.overflow-x-auto`
    // 14 ms after the menu mounted, then focus back on the ⋮ button. A wide enough viewport has nothing to scroll.
    viewport: { width: 1672, height: 941 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Real I/O, not a mock: an upload is a staged PUT and a trash is a queued op the UI polls.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1672, height: 941 }, storageState: AUTH_STATE },
      dependencies: ['setup'],
    },
  ],

  // `vite preview` serves `app/dist` and proxies `/api` + `/admin` to FILEX_API_PROXY (app/vite.config.ts), so the
  // browser sees ONE origin and the session cookie rides along without CORS.
  //
  // ⚠ `reuseExistingServer: false`, unlike the mock suite. A stray server on this port would be serving somebody
  // else's bundle — possibly a mock one — and every result it produced would be a lie about this build.
  webServer: {
    command: `pnpm --filter ./app exec vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: path.resolve(E2E_DIR, '..'),
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
