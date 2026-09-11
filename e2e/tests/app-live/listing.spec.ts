import { test, expect, type Page } from '@playwright/test';

/**
 * The listing itself: the order rows come in, what the selection bar can do to them, and what the flat listings
 * say about where a row lives.
 *
 * The audit's findings under test — §5.1 names sorted lexicographically, so `file 10` came before `file 2`;
 * §5.4 no sort by type and no type column at all; §3.3 `Copy` offered for one row but not for a selection;
 * §2.7 the toast after a move had no `Undo` while the one after a delete did; §9.2 / §10 Starred and Recent
 * never said which folder a row came from.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Listing E2E';
const TARGET = 'Listing E2E Target';
/** Named so lexicographic order and natural order disagree: `file 10` sorts before `file 2` without `numeric`. */
const NUMBERED = ['file 2.txt', 'file 10.txt', 'file 100.txt'];

test.describe.configure({ mode: 'serial' });

function card(page: Page, name: string) {
  return page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
}

async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  await expect(page.getByRole('radio', { name: 'Grid view' })).toBeVisible();
}

/** Switches to list view, where the sortable table headers and the metadata columns live. */
async function listView(page: Page) {
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  await expect(page.getByRole('grid')).toBeVisible();
}

async function gridView(page: Page) {
  const grid = page.getByRole('radio', { name: 'Grid view' });
  if ((await grid.getAttribute('aria-checked')) !== 'true') await grid.click();
}

async function newFolder(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();
}

async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles(files);
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 60_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
}

/** The file names of the listing, top to bottom, as the table draws them. */
async function order(page: Page) {
  return page.getByRole('grid').getByRole('row').locator('td:nth-child(2)').allInnerTexts();
}

test('the fixture: numbered files, a few types and a folder to move into', async ({ page }) => {
  await open(page);
  await gridView(page);
  await newFolder(page, FOLDER);
  await newFolder(page, TARGET);

  await open(page, FOLDER);
  await upload(page, [
    ...NUMBERED.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) })),
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Title\n\nA line.\n\n- one\n- two\n') },
    { name: 'sheet.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') },
  ]);
  await page.reload();
  await expect(card(page, 'notes.md')).toBeVisible();
});

// §5.1: without `numeric` the comparator read the digits as characters, so a folder of `IMG_2 … IMG_10` came out
// in an order nobody names files for.
test('a run of digits in a name sorts as the number it is', async ({ page }) => {
  await open(page, FOLDER);
  await listView(page);
  const name = page.getByRole('grid').getByRole('columnheader').getByRole('button', { name: 'Name' });
  // Ascending: the header starts a new key ascending, and a second press would reverse it.
  await name.click();
  if (!(await page.getByRole('grid').locator('th[aria-sort="ascending"]').count())) await name.click();

  const rows = (await order(page)).map((text) => text.trim().split('\n')[0]);
  const numbered = rows.filter((n) => NUMBERED.includes(n));
  expect(numbered).toEqual(['file 2.txt', 'file 10.txt', 'file 100.txt']);
});

// §5.4: the sort menu offered Name, Modified and Size only, and the listing never named a row's type anywhere.
test('the listing can be sorted by type, and names the type it sorted by', async ({ page }) => {
  await open(page, FOLDER);
  await listView(page);
  await expect(page.getByRole('grid').getByRole('columnheader', { name: 'Type' })).toBeVisible();

  await page.getByRole('grid').getByRole('columnheader').getByRole('button', { name: 'Type' }).click();
  const rows = await order(page);
  expect(rows.length).toBeGreaterThan(0);
  // The column prints a readable type, not the raw group: "Markdown" for the .md, "Spreadsheet" for the .csv.
  const types = await page.getByRole('grid').getByRole('row').locator('td:nth-child(3)').allInnerTexts();
  expect(types.map((t) => t.trim())).toContain('Markdown');
  expect(types.map((t) => t.trim())).toContain('Spreadsheet');
});

// §3.3: "Copy to" was in every row's ⋮ menu and in no selection bar, so several files could be moved at once but
// not duplicated at once.
test('a selection can be copied, not only moved', async ({ page }) => {
  await open(page, FOLDER);
  await listView(page);
  const rows = page.getByRole('grid').getByRole('row');
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ['Control'] });

  const bar = page.getByRole('toolbar', { name: /2 selected/ });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Copy to' }).click();
  await expect(page.getByRole('heading', { name: /^Copy/ })).toBeVisible();
  // The dialog has two of them: the ✕ in its corner and the footer button.
  await page.getByRole('button', { name: 'Cancel' }).last().click();
});

// §2.7: the step was recorded and Ctrl+Z ran it; only the toast said nothing, and a move is the action that takes
// the rows off the screen.
test('the toast after a move offers to undo it', async ({ page }) => {
  await open(page, FOLDER);
  await gridView(page);
  await card(page, 'sheet.csv').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Move to', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('option', { name: TARGET }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();

  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  await expect(card(page, 'sheet.csv')).toHaveCount(0);
  await undo.click();
  // Back where it was, without the person having to find the target folder again.
  await expect(card(page, 'sheet.csv')).toBeVisible({ timeout: 15_000 });
});

// §9.2 / §10: a starred row named a file and nothing else — which folder it came from was not on screen at all.
test('Starred says which folder a row lives in, and goes there', async ({ page }) => {
  await open(page, FOLDER);
  await gridView(page);
  await card(page, 'notes.md').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Add to starred' }).click();

  await page.goto('starred');
  await expect(page.getByRole('heading', { name: 'Starred', level: 1 })).toBeVisible();
  const location = page.getByRole('grid').getByRole('button', { name: new RegExp(FOLDER) });
  await expect(location.first()).toBeVisible();

  await location.first().click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(FOLDER).replace(/%20/g, '(%20| )')));
});

// §22: taking the last star off ON the Starred page left a table with column headings and no rows — a listing
// that says nothing about why it is blank. The star is removed from this page rather than from the folder,
// because it is that order of events the audit caught.
test('the last star coming off leaves the empty state, not an empty table', async ({ page }) => {
  await page.goto('starred');
  const row = page.getByRole('grid').getByRole('row').filter({ hasText: 'notes.md' });
  await expect(row).toHaveCount(1);

  await row.click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Remove from starred' }).click();

  await expect(page.getByText('No starred items')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('grid')).toHaveCount(0);
});

// §13.2: a row another client has already deleted. The listing on screen is a snapshot, so this is not a race to
// be prevented — the question is only whether acting on a stale row says something a person can act on.
test('acting on a row somebody else deleted says what happened', async ({ page }) => {
  await open(page, FOLDER);
  await gridView(page);
  await expect(card(page, 'file 100.txt')).toBeVisible();

  // The other client: the same account over the API, which is what a second tab or another device is.
  const gone = await page.request.post('/api/files/delete', {
    data: { source: [`${DRIVE}://${FOLDER}/file 100.txt`] },
  });
  expect(gone.ok(), `delete answered ${gone.status()}: ${await gone.text()}`).toBe(true);

  await card(page, 'file 100.txt').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Rename' }).fill('renamed.txt');
  await dialog.getByRole('button', { name: 'Rename' }).click();

  // Whatever it says, it has to SAY something, and the row must not still be sitting there afterwards.
  await expect(page.getByRole('alert').or(page.getByRole('status'))).toBeVisible({ timeout: 15_000 });
  await expect(card(page, 'file 100.txt')).toHaveCount(0, { timeout: 15_000 });
});
