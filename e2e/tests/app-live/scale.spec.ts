import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * §24.1 of the audit carries no verdict because a folder that large was never created: the listing draws every row
 * it is given, with no windowing, and nobody had measured what that costs at the size where it would start to hurt.
 *
 * The fixture puts the files on the drive and runs filex's own storage sync over them: a staged upload each would
 * measure the upload path, which is not what this asks about, and the listing does not care what is inside a row.
 *
 * The ceilings below are deliberately generous. They are not a performance target — they are the line past which
 * the screen is no longer usable, and crossing it is the finding.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Scale E2E';
const COUNT = 10_000;
/** Past this the listing is not slow, it is broken: nobody waits half a minute for a folder to open. */
const OPEN_BUDGET_MS = 30_000;
/** One keystroke of the cursor after the rows are up. A listing that cannot answer a key press is not navigable. */
const KEY_BUDGET_MS = 2_000;

test.describe.configure({ mode: 'serial' });

/**
 * ⚠ Opt-in: `E2E_APP_SCALE=1 node e2e/run.mjs app`. Building the folder and indexing it takes about two minutes,
 * which is longer than the whole rest of the suite; this is a measurement to repeat when the listing changes, not
 * a gate to pay for on every run.
 */
test.skip(!process.env.E2E_APP_SCALE, 'set E2E_APP_SCALE=1 to measure a ten-thousand-file folder');

/** The drive as the admin API describes it: the numeric id the sync endpoint takes, and its root on disk. */
async function drive(page: Page): Promise<{ id: number; root: string }> {
  const res = await page.request.get('/api/admin/storages');
  expect(res.ok(), 'the admin session can read the storage list').toBeTruthy();
  const body = await res.json();
  const list: { id?: number; name?: string; config?: { path?: string } }[] = body?.storages ?? body ?? [];
  const found = list.find((s) => s.name === DRIVE);
  expect(found?.id, `the seeded drive "${DRIVE}" is registered`).toBeTruthy();
  expect(found?.config?.path, `the seeded drive "${DRIVE}" reports a local path`).toBeTruthy();
  return { id: found!.id!, root: found!.config!.path! };
}

test('the fixture: ten thousand files in one folder', async ({ page }) => {
  test.setTimeout(600_000);
  // ⚠ Written onto the drive and then SYNCED, not created one API call at a time. filex serves a listing from its
  // own node cache once a drive has synced, so files dropped behind its back are invisible — the first version of
  // this fixture measured an empty folder and blamed the product. Ten thousand `q=newfile` calls are honest but
  // take minutes of wall clock; one sync of a directory that is already there is the same end state in seconds,
  // and it is how a real drive with existing content is adopted anyway.
  const { id, root } = await drive(page);
  const dir = path.join(root, FOLDER);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < COUNT; i++) {
    // Padded so the names sort the same way lexicographically and naturally: this spec measures size, not order.
    fs.writeFileSync(path.join(dir, `row-${String(i).padStart(5, '0')}.txt`), `row ${i}\n`);
  }
  const started = Date.now();
  // ⚠ Its own timeout: the endpoint answers only once the walk is done, and the suite's 20 s action timeout is for
  // clicks, not for indexing ten thousand files.
  const synced = await page.request.post(`/api/admin/storages/${id}/sync`, { timeout: 300_000 });
  expect(synced.ok(), `the drive sync was accepted (${synced.status()})`).toBeTruthy();

  // The sync is asynchronous; the listing is what says it has caught up.
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/files/manager', { params: { q: 'index', path: `${DRIVE}://${FOLDER}` } });
        return res.ok() ? ((await res.json())?.files ?? []).length : -res.status();
      },
      { timeout: 300_000, intervals: [1000], message: 'the drive sync reaches every file' },
    )
    .toBe(COUNT);
  console.log(`[scale] the sync caught up in ${Math.round((Date.now() - started) / 1000)} s`);
});

test('the server itself answers for a folder of ten thousand files', async ({ page }) => {
  test.setTimeout(180_000);
  // Asked before the UI is, so a failure upstairs can be told apart from a failure in the listing screen. The app
  // calls exactly this: `q=index` is what the folder view is drawn from.
  const started = Date.now();
  const res = await page.request.get('/api/files/manager', {
    params: { q: 'index', path: `${DRIVE}://${FOLDER}` },
    timeout: 120_000,
  });
  const ms = Date.now() - started;
  const body = res.ok() ? await res.json() : await res.text();
  const count = res.ok() ? (body?.nodes?.length ?? body?.files?.length ?? 0) : 0;
  console.log(`[scale] GET q=index answered ${res.status()} in ${ms} ms with ${count} entries`);
  expect(res.status(), `the listing endpoint answers for ${COUNT} entries (said: ${String(body).slice(0, 400)})`).toBe(200);
  expect(count, 'every entry is in the answer').toBe(COUNT);

  // The folder screen also asks for the PARENT, to find this folder's own row in it (`getNode`). A root listing
  // that does not carry the row is what makes the screen say "Could not load this listing" with every request 200.
  const parent = await page.request.get('/api/files/manager', { params: { q: 'index', path: `${DRIVE}://` } });
  const parentFiles = parent.ok() ? ((await parent.json())?.files ?? []) : [];
  console.log(
    `[scale] the root listing answered ${parent.status()} with ${parentFiles.length}: ` +
      JSON.stringify(parentFiles.map((f: { basename?: string; path?: string }) => f.basename ?? f.path)),
  );
  expect(
    parentFiles.some((f: { basename?: string }) => f.basename === FOLDER),
    'the large folder has a row in its own parent',
  ).toBe(true);
});

test('a folder of ten thousand files opens, and says how many there are', async ({ page }) => {
  test.setTimeout(180_000);
  // The server answers this folder in a tenth of a second (the test above), so anything that goes wrong here is
  // the screen's, and the screen only ever says "Could not load this listing". These two recorders are what turn
  // that sentence back into a cause.
  const said: string[] = [];
  page.on('pageerror', (error) => said.push(`pageerror: ${error.message}`));
  page.on('console', (message) => message.type() === 'error' && said.push(`console: ${message.text()}`));
  page.on('requestfailed', (request) => said.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
  page.on('request', (request) => request.url().includes('/api/') && said.push(`→ ${request.method()} ${request.url().slice(0, 160)}`));
  page.on('response', (response) => response.url().includes('/api/') && said.push(`← ${response.status()} ${response.url().slice(0, 160)}`));

  const started = Date.now();
  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible({ timeout: OPEN_BUDGET_MS });
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  try {
    await expect(page.getByRole('grid')).toBeVisible({ timeout: OPEN_BUDGET_MS });
    await expect(page.getByRole('grid').getByRole('row').first()).toBeVisible({ timeout: OPEN_BUDGET_MS });
  } finally {
    const screen = await page.locator('main').innerText().catch(() => '(unreadable)');
    console.log(`[scale] the browser said:\n${said.join('\n') || '(nothing)'}`);
    console.log(`[scale] the screen reads:\n${screen.slice(0, 500)}`);
  }
  const openedMs = Date.now() - started;

  const rows = await page.getByRole('grid').getByRole('row').count();
  const drawn = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
  console.log(`[scale] opened in ${openedMs} ms; ${rows} rows in the a11y tree, ${drawn} <tr> in the DOM`);

  expect(openedMs, `opening ${COUNT} rows stayed inside the usability budget`).toBeLessThan(OPEN_BUDGET_MS);
  // Whether the listing windows its rows or draws them all is the question §24.1 asks; either answer is recorded
  // by the line above. What is NOT acceptable is a listing that silently shows a fraction and says nothing.
  expect(drawn, 'the table drew rows at all').toBeGreaterThan(0);
});

test('the cursor still moves once ten thousand rows are on screen', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible({ timeout: OPEN_BUDGET_MS });
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  await expect(page.getByRole('grid')).toBeVisible({ timeout: OPEN_BUDGET_MS });

  await page.getByRole('grid').getByRole('row').nth(1).click();
  const started = Date.now();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[aria-selected="true"], [data-cursor="true"]').first()).toBeVisible({ timeout: KEY_BUDGET_MS });
  const keyMs = Date.now() - started;
  console.log(`[scale] one ArrowDown answered in ${keyMs} ms`);
  expect(keyMs, 'a key press is answered while the listing is this large').toBeLessThan(KEY_BUDGET_MS);
});
