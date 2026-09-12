import { test, expect, type Page } from '@playwright/test';

/**
 * §11.2 of the audit carries no verdict because the scenario was never assembled: trash a file, put a NEW file of
 * the same name in its place, then restore the old one. The restore has nowhere to land that is free, and the
 * question is whether the product says so, renames one of the two, or quietly loses one of them.
 *
 * Losing one is the failure this probe exists to catch: both files are somebody's, and a restore that silently
 * overwrote the newer one would be a data loss with no message and no undo.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Restore E2E';
const NAME = 'clash.txt';
const OLD = 'the first one, trashed';
const NEW = 'the second one, made after';

test.describe.configure({ mode: 'serial' });

function row(page: Page, name: string) {
  return page.getByRole('grid').getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
}

async function pickMenu(page: Page, name: string, entry: string) {
  await row(page, name).getByRole('button', { name: 'More' }).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: entry, exact: true }).click();
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

async function upload(page: Page, name: string, text: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles([{ name, mimeType: 'text/plain', buffer: Buffer.from(text) }]);
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 60_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
}

async function trash(page: Page, name: string) {
  await pickMenu(page, name, 'Move to trash');
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: 'Move to trash?' })).toBeVisible();
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirm).toBeHidden();
}

test('the fixture: a file is trashed and a new file takes its name', async ({ page }) => {
  await open(page);
  await newFolder(page, FOLDER);
  await open(page, FOLDER);
  await upload(page, NAME, OLD);
  await trash(page, NAME);
  await expect(row(page, NAME)).toHaveCount(0);
  await upload(page, NAME, NEW);
  await expect(row(page, NAME)).toHaveCount(1);
});

/**
 * ⚠ `test.fail()`: measured on the stand, the restore OVERWRITES the newer file and says nothing — one `clash.txt`
 * is left and it holds the older, restored bytes. That is a silent data loss, not a rough edge, and it is the
 * server's: `trash.Service.Restore` renames the trashed file back onto its original path, and a rename onto an
 * occupied name replaces what is there. Until that is decided (refuse, or land under a free name), this records
 * the defect without turning the release gate red for a known thing — and starts failing the day it is fixed.
 */
test('restoring onto an occupied name keeps both files and says what happened', async ({ page }) => {
  test.fail();
  await page.goto('trash');
  // ⚠ No view toggle here: the trash is a table and only a table, so there is nothing to switch.
  await expect(page.getByRole('heading', { name: 'Trash', level: 1 })).toBeVisible();
  await listView(page);
  const toast = page.getByRole('status');
  await pickMenu(page, NAME, 'Restore');

  // Read BEFORE anything else: a toast auto-dismisses, and the end state below takes seconds to check. Whatever
  // the product chooses — refuse, or land under a free name — it has to SAY so, because a silent success is
  // indistinguishable from an overwrite to the person watching.
  let said = '';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !said) {
    said = (await toast.innerText().catch(() => '')).trim();
    if (!said) await page.waitForTimeout(200);
  }
  console.log(`[restore-conflict] the app said: ${said || '(nothing)'}`);

  await open(page, FOLDER);
  await listView(page);
  // The newer file must still be there with its own bytes, and the restored one must be somewhere too: two rows,
  // not one. A single row means one of the two is gone.
  const rows = await page.getByRole('grid').getByRole('row').locator('td:nth-child(2)').allInnerTexts();
  const named = rows.filter((r) => r.includes('clash'));
  const kept = await page.request.get(
    `/api/files/manager?q=download&path=${encodeURIComponent(`${DRIVE}://${FOLDER}/${NAME}`)}`,
  );
  const body = kept.ok() ? await kept.text() : `(http ${kept.status()})`;
  console.log(`[restore-conflict] rows now: ${JSON.stringify(named)}; "${NAME}" holds: ${body.trim()}`);

  // The newer file is somebody's current work. A restore that replaces it with an older copy of the same name,
  // and says nothing, is a silent data loss — that is what these two assertions are for, in that order.
  expect(kept.ok(), 'the file that held the name is still readable').toBeTruthy();
  expect(body, 'the newer file was not overwritten by the restore').toBe(NEW);
  expect(named.length, `both files survive the restore, got: ${JSON.stringify(named)}`).toBe(2);

  // Asserted LAST, so a run that fails here has already reported what happened to the two files above: losing one
  // is the serious defect, saying nothing about a restore that worked is the smaller one.
  expect(said, 'the restore is reported, one way or the other').not.toBe('');
});
