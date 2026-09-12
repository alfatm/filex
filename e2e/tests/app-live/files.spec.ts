import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ADMIN_EMAIL } from '../../helpers/auth';

/**
 * The end-user app driven against a REAL filex server — the HTTP repository (`app/src/data/http/`) and its contract
 * with the Go handlers, which nothing else in this repository covers.
 *
 * What makes a spec belong here — the bar set when a mock-driven suite still existed beside it, and worth keeping
 * now that this is the only suite:
 *
 *   • it must not be able to pass without a server. Every row these tests read was created by the test through
 *     the UI and stored by the server; nothing asserts a fixture constant ("12.4 GB of 100 GB used",
 *     "demo@filex.local", "14 matching items"), and the first test asserts those constants are ABSENT.
 *   • it must survive a reload. A row that is still there after `page.reload()` came from the server, not from a
 *     store that was optimistic about a call that failed.
 *
 * ⚠ Serial and stateful ON PURPOSE. One drive, one folder, one file, one story: create → upload → rename →
 * collide → trash → restore → download. Splitting it into independent tests would mean seeding through the API,
 * and then the API — not the UI — would be what created the rows.
 */

/** The drive the harness seeded. Node ids are `<drive>://path`, so nothing here can be guessed. */
const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Live E2E';
const FIRST = 'hello.txt';
const SECOND = 'notes.md';
const RENAMED = 'renamed.txt';
const BODY = 'hello from the live suite\n';

test.describe.configure({ mode: 'serial' });

/** The list row whose name cell reads exactly `name`. */
function row(page: Page, name: string) {
  return page.getByRole('grid').locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) });
}

/** Opens the ⋮ menu of a list row and picks an entry. */
async function pickMenu(page: Page, name: string, entry: string) {
  await row(page, name).getByRole('button', { name: 'More' }).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: entry, exact: true }).click();
}

/**
 * Navigates to a folder and puts the listing in list view.
 *
 * ⚠ Not `?view=list`. That query hook was a dev-only shortcut and it no longer exists, so this clicks the control
 * a user clicks — which is what a suite against a real server should have been doing anyway. View mode is
 * per-browser-context state (localStorage) and Playwright gives every test a fresh context, so this runs per
 * navigation rather than once.
 */
async function openFolder(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  await expect(list).toHaveAttribute('aria-checked', 'true');
}

/** New → <entry> from the sidebar. */
async function newMenu(page: Page, entry: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const menu = page.getByRole('menu', { name: 'New' });
  await expect(menu).toBeVisible();
  return menu.getByRole('menuitem', { name: entry, exact: true });
}

test('the shell boots against the server, and none of the mock dataset is on screen', async ({ page }) => {
  await openFolder(page);

  // The drive is the one the harness registered, under the name it registered it with.
  const sidebar = page.getByRole('navigation').first();
  await expect(sidebar.getByRole('link', { name: DRIVE, exact: true })).toBeVisible();

  // The three constants the mock suite asserts. Their absence is the whole point of this file: if any of them is
  // here, the bundle under test is serving demo data and every other assertion below is worthless.
  await expect(page.getByText('12.4 GB of 100 GB used')).toHaveCount(0);
  await expect(page.getByText('demo@filex.local')).toHaveCount(0);

  // And the account really is the one that signed in.
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'User settings' })).toBeVisible();
  await expect(dialog.getByText(ADMIN_EMAIL).first()).toBeVisible();
});

test('New → Folder creates a directory the server still reports after a reload', async ({ page }) => {
  await openFolder(page);
  await (await newMenu(page, 'Folder')).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  await expect(row(page, FOLDER)).toBeVisible();
  // The reload is the assertion: an optimistic store would show the row either way.
  await page.reload();
  await expect(row(page, FOLDER)).toBeVisible();
});

test('a second folder of the same name is refused, and the first one survives', async ({ page }) => {
  await openFolder(page);
  await (await newMenu(page, 'Folder')).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();

  // A readable sentence, not "HTTP 409" and not a dialog that closes as though it had worked.
  await expect(dialog.getByRole('alert')).toHaveText('An item with this name already exists');
  // ⚠ `getByText`, not `getByRole('button', { name: 'Cancel' })`: the dialog's ✕ carries aria-label="Cancel" too,
  // so the role query matches two controls and fails strict mode.
  await dialog.getByText('Cancel', { exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(row(page, FOLDER)).toHaveCount(1);
});

test('New → Upload files puts real bytes in the folder', async ({ page }) => {
  await openFolder(page, FOLDER);

  for (const [name, mime, body] of [
    [FIRST, 'text/plain', BODY],
    [SECOND, 'text/markdown', '# notes\n'],
  ] as const) {
    await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
    await (await chooser).setFiles({ name, mimeType: mime, buffer: Buffer.from(body) });

    const tray = page.getByRole('region', { name: /^Uploading|upload complete$/ });
    await expect(tray).toContainText(name);
    // "complete" means the staged upload was committed AND the queued op finished — not that a timer elapsed.
    await expect(tray.getByText('1 upload complete')).toBeVisible({ timeout: 30_000 });
    await tray.getByRole('button', { name: 'Close' }).click();
  }

  await page.reload();
  await expect(row(page, FIRST)).toBeVisible();
  await expect(row(page, FIRST)).toContainText(`${BODY.length} B`);
  await expect(row(page, SECOND)).toBeVisible();
});

test('Rename moves the file on the server', async ({ page }) => {
  await openFolder(page, FOLDER);
  await pickMenu(page, FIRST, 'Rename');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Rename' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Rename' }).fill(RENAMED);
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(row(page, RENAMED)).toBeVisible();
  await expect(row(page, FIRST)).toHaveCount(0);
});

test('renaming onto a name that is taken is refused, and neither file moves', async ({ page }) => {
  await openFolder(page, FOLDER);
  await pickMenu(page, SECOND, 'Rename');

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Rename' }).fill(RENAMED);
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('An item with this name already exists');
  await dialog.getByText('Cancel', { exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(row(page, SECOND)).toBeVisible();
  await expect(row(page, RENAMED)).toBeVisible();
});

test('Move to trash and Restore travel through the server, not the store', async ({ page }) => {
  await openFolder(page, FOLDER);
  await pickMenu(page, SECOND, 'Move to trash');
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: 'Move to trash?' })).toBeVisible();
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirm).toBeHidden();

  await page.reload();
  await expect(row(page, SECOND)).toHaveCount(0);

  await page.getByRole('navigation').first().getByRole('link', { name: 'Trash', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trash', level: 1 })).toBeVisible();
  await expect(row(page, SECOND)).toBeVisible();

  await pickMenu(page, SECOND, 'Restore');
  await expect(row(page, SECOND)).toHaveCount(0);

  await openFolder(page, FOLDER);
  await expect(row(page, SECOND)).toBeVisible();
});

test('Download hands back the bytes that were uploaded', async ({ page }) => {
  /*
   * The regression guard for a URL bug this suite caught: `downloadUrl` used to be built in the UI by appending
   * `?download=1` to `node.assetUrl`, which was right for the mock's static file URLs and wrong for HTTP, where
   * `assetUrl` already carries a query string — the second '?' made `path` read as
   * `live://Live E2E/renamed.txt?download=1`, and Chromium reported the download as `canceled`. Building the URL
   * is now the data layer's job (`repository.downloadUrl(id)`), so a UI that goes back to string-concatenation
   * fails here on the bytes, not on a suggested filename.
   */

  await openFolder(page, FOLDER);

  const started = page.waitForEvent('download');
  await pickMenu(page, RENAMED, 'Download');
  const download = await started;
  expect(download.suggestedFilename()).toBe(RENAMED);

  const path = await download.path();
  expect(path, 'the browser refused the download').not.toBeNull();
  expect(readFileSync(path as string, 'utf8')).toBe(BODY);
});
