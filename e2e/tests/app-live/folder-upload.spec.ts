import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * §2.2 of the audit carries no verdict because the harness could not hand the browser a real directory: the picker
 * behind New → Upload folder is an `<input webkitdirectory>`, and a synthetic file list carries no
 * `webkitRelativePath`, which is the only thing the upload store has to rebuild the tree from.
 *
 * Playwright can set a DIRECTORY on such an input, so the gap closes: the fixture below is a real nested folder on
 * disk, and what lands on the server has to be the same shape — the nesting, not a flat heap of files.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Folder Upload E2E';
const TREE = 'uploaded-tree';

test.describe.configure({ mode: 'serial' });

/** A real directory with two levels and a name repeated across them, so a flattening bug cannot hide as a collision. */
function makeTree(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'filex-folder-upload-'));
  const root = path.join(base, TREE);
  fs.mkdirSync(path.join(root, 'inner', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'top.txt'), 'top level\n');
  fs.writeFileSync(path.join(root, 'inner', 'same.txt'), 'inner copy\n');
  fs.writeFileSync(path.join(root, 'inner', 'deeper', 'same.txt'), 'deeper copy\n');
  return root;
}

/**
 * ⚠ Opening a folder does NOT wait for the table: an EMPTY folder draws the empty state and no `grid` at all, and
 * waiting for one there is a 15 s timeout on a fixture that is working exactly as intended. The view control is
 * the thing that is always on screen, so it is what says the listing has arrived. `listView` is for the tests
 * that then need the table.
 */
async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
}

async function listView(page: Page) {
  await expect(page.getByRole('grid')).toBeVisible();
}

async function newFolder(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();
}

function row(page: Page, name: string) {
  return page.getByRole('grid').getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
}

test('the fixture: an empty folder to upload into', async ({ page }) => {
  await open(page);
  await newFolder(page, FOLDER);
});

test('New → Upload folder recreates the whole tree, not a flat list of files', async ({ page }) => {
  test.setTimeout(120_000);
  const root = makeTree();
  await open(page, FOLDER);

  // The input is hidden and driven by the menu entry; setting it directly is what a directory picker does, and it
  // is the only way to hand the page a real `webkitRelativePath` for every file.
  await page.locator('input[webkitdirectory]').setInputFiles(root);

  const tray = page.getByRole('region', { name: /^Uploading|uploads? (complete|failed)$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 90_000 });
  await expect(tray.getByText(/uploads? failed/)).toHaveCount(0);
  await tray.getByRole('button', { name: 'Close' }).click();

  await open(page, FOLDER);
  await listView(page);
  await expect(row(page, TREE), 'the picked folder itself is recreated').toHaveCount(1);
  await open(page, FOLDER, TREE);
  await listView(page);
  await expect(row(page, 'top.txt')).toHaveCount(1);
  await expect(row(page, 'inner')).toHaveCount(1);
  await open(page, FOLDER, TREE, 'inner');
  await listView(page);
  await expect(row(page, 'same.txt')).toHaveCount(1);
  await expect(row(page, 'deeper')).toHaveCount(1);
  await open(page, FOLDER, TREE, 'inner', 'deeper');
  await listView(page);
  await expect(row(page, 'same.txt')).toHaveCount(1);

  // The two `same.txt` are different files at different depths; a flattening bug would have made them one.
  const deep = await page.request.get(
    `/api/files/manager?q=download&path=${encodeURIComponent(`${DRIVE}://${FOLDER}/${TREE}/inner/deeper/same.txt`)}`,
  );
  expect(deep.ok()).toBeTruthy();
  expect(await deep.text()).toBe('deeper copy\n');

  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});
