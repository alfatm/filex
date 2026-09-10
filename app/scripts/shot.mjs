// Screenshot helper for design comparison against app/docs/DESIGN-SPEC.md.
//
//   pnpm --filter ./app shot [route] [name] [baseUrl]
//   e.g. pnpm --filter ./app shot "/files?select=Design&panel=details" files-grid-details
//
// Expects a dev server already running (default http://localhost:5174/app/).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const VIEWPORT = { width: 1672, height: 941 };
const OUT_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../shots');

const [route = '/files', name = 'files', base = 'http://localhost:5174/app/'] = process.argv.slice(2);
const url = new URL(route.replace(/^\//, ''), base).href;

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const file = path.join(OUT_DIR, `${name}.png`);
await page.screenshot({ path: file });
await browser.close();
console.log(file);
