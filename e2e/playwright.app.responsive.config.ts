import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(E2E_DIR, '../app');

/**
 * Playwright config for `app/` AT THREE WIDTHS — the responsive suite (DESIGN-SPEC §10).
 *
 *   playwright.config.ts             admin SPA + HTTP contracts, real backend   (node e2e/run.mjs local)
 *   playwright.app.live.config.ts    app/, real backend, journeys that MUTATE   (node e2e/run.mjs app --build)
 *   THIS ONE                         app/, real backend, READ-ONLY, 3 viewports (node e2e/run.mjs app-responsive)
 *
 * The difference that matters is not the viewports — it is that these specs only look. The live suite is serial
 * with one worker because its specs rename and trash rows in a shared tree; nothing here writes, so the three
 * widths run at the same time instead of one after the other, and a failure at 390 leaves nothing behind for 834.
 *
 * ⚠ Do NOT run this config by hand: it needs a server, the demo-assets fixture catalogued by the server's own sync
 * worker, and a bundle built against that server. `run.mjs app-responsive` is what arranges all three.
 *
 * ⚠ baseURL ends in `/`: navigate with `page.goto('files')`, not `page.goto('/files')`.
 */

/** Where `vite preview` will serve `app/dist`. run.mjs picks a free one; 5179 is the bare-hands default. */
const PORT = Number(process.env.E2E_APP_PORT) || 5179;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

const API_PROXY = process.env.FILEX_API_PROXY;
const HOW = 'Run:  node e2e/run.mjs app-responsive --build';

if (!API_PROXY) throw new Error(`FILEX_API_PROXY is not set: there is no server for this suite to talk to.\n${HOW}`);
if (!process.env.E2E_APP_STORAGE) {
  throw new Error(`E2E_APP_STORAGE is not set: the specs address every node as "<drive>://path".\n${HOW}`);
}
if (!existsSync(path.join(APP_DIR, 'dist', 'index.html'))) {
  throw new Error(`there is no build at ${path.join(APP_DIR, 'dist')}: \`vite preview\` would serve nothing.\n${HOW}`);
}

/** `--shots`: the same stand, taking the screenshot catalogue instead of asserting. One or the other, never both. */
const SHOTS = process.env.E2E_APP_SHOTS === '1';

const AUTH_STATE = path.join(E2E_DIR, 'test-results', 'app-responsive', 'auth.json');

/**
 * The three targets of the reference sheet. Touch is part of the definition, not decoration: `pointer: coarse` is
 * what raises the control tokens (tokens.css), so a phone measured with a mouse would be measuring a layout no
 * phone ever draws.
 */
export const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 834, height: 1112 }, hasTouch: true, deviceScaleFactor: 2 },
  // The width the spec is measured at, and the one the live suite pins for the same reason.
  desktop: { viewport: { width: 1672, height: 941 }, hasTouch: false, deviceScaleFactor: 1 },
} as const;

export default defineConfig({
  testDir: './tests/app-responsive',
  outputDir: 'test-results/app-responsive',
  timeout: 60_000,
  expect: { timeout: 15_000 },

  // Read-only specs against one seeded drive: they may all run at once.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [['html', { outputFolder: 'playwright-report/app-responsive', open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    ...Object.entries(VIEWPORTS).map(([name, device]) => ({
      name,
      use: { ...device, storageState: AUTH_STATE },
      dependencies: ['setup'],
      // The catalogue and the assertions never run together: one of them is always the job that was asked for,
      // which is also why the catalogue is not named `.spec.ts` — it asserts nothing.
      testMatch: SHOTS ? /catalogue\.shots\.ts$/ : /\.spec\.ts$/,
    })),
  ],

  webServer: {
    command: `pnpm --filter ./app exec vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: path.resolve(E2E_DIR, '..'),
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
