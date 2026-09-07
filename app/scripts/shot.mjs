// Screenshot helper for design comparison against app/docs/DESIGN-SPEC.md.
//
//   pnpm --filter ./app shot [route] [name] [baseUrl]
//   e.g. pnpm --filter ./app shot "/files?select=Design&panel=details" files-grid-details
//
// Expects a dev server already running (default http://localhost:5174/app/).
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const VIEWPORT = { width: 1672, height: 941 };
const OUT_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../shots');

const [route = '/files', name = 'files', base = 'http://localhost:5174/app/'] = process.argv.slice(2);
const url = new URL(route.replace(/^\//, ''), base).href;

// The pinned @playwright/test may expect a different chromium build than the
// one already in the cache; reuse the newest cached headless shell instead of
// downloading another browser.
function cachedExecutable() {
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = path.join(homedir(), '.cache', 'ms-playwright');
  const builds = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse();
  if (!builds.length) return undefined;
  return path.join(cache, builds[0], 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ executablePath: cachedExecutable() });
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const file = path.join(OUT_DIR, `${name}.png`);
await page.screenshot({ path: file });
await browser.close();
console.log(file);
