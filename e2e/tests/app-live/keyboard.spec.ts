import { test, expect, type Page } from '@playwright/test';

/**
 * §15 and §28 of the audit: the arrows did not move the row cursor, `Ctrl+K` did nothing although the field draws
 * a ⌘K hint, `Delete` was never checked, and Tab walked the sidebar and the header without ever reaching the
 * listing — which leaves the whole table unreachable without a mouse.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Keyboard E2E';
const FILES = ['k-one.txt', 'k-two.txt', 'k-three.txt'];

test.describe.configure({ mode: 'serial' });

function grid(page: Page) {
  return page.getByRole('grid');
}

async function open(page: Page) {
  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  await expect(grid(page).locator('tbody tr')).toHaveCount(FILES.length);
}

test('the fixture: a folder with three files', async ({ page }) => {
  await page.goto(`files/${encodeURIComponent(DRIVE)}`);
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();

  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles(FILES.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) })));
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 60_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
});

test('Ctrl+K puts the caret in the search box', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox', { name: 'Search' })).toBeFocused();
});

test('the first Tab offers the listing', async ({ page }) => {
  await open(page);
  // Tab has to start from the top of the document. Blurring is not enough — Chromium remembers where sequential
  // navigation left off — so the page is loaded fresh, with nothing clicked on it.
  await page.reload();
  await expect(page.getByRole('grid')).toBeVisible();

  // Measured before this link existed: walking the shell with Tab alone did not reach the listing inside sixty
  // presses from the top of the page (it was still in the toolbar, on `Details`), and thirty-three even when the
  // walk started past the sidebar. So the listing gets the FIRST stop on the page.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('button', { name: 'Skip to files' });
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page.getByRole('grid')).toBeFocused();

  // And from there the listing's own keys work, which is the point of landing on it rather than near it.
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('grid')).toHaveAttribute('aria-activedescendant', /node-/);
});

test('the arrows move the row cursor, and Enter opens what it stands on', async ({ page }) => {
  await open(page);
  await grid(page).focus();
  await page.keyboard.press('ArrowDown');
  const first = await grid(page).getAttribute('aria-activedescendant');
  expect(first, 'ArrowDown moved nothing').toBeTruthy();

  await page.keyboard.press('ArrowDown');
  const second = await grid(page).getAttribute('aria-activedescendant');
  expect(second).not.toBe(first);

  await page.keyboard.press('ArrowUp');
  expect(await grid(page).getAttribute('aria-activedescendant')).toBe(first);

  // The cursor is a real position: Enter opens the file it stands on.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Delete asks, and trashes the row the cursor stands on', async ({ page }) => {
  await open(page);
  await grid(page).focus();
  await page.keyboard.press('ArrowDown');
  const name = await grid(page).locator('tbody tr').first().innerText();
  const doomed = name.split('\n')[0];

  await page.keyboard.press('Delete');
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: 'Move to trash?' })).toBeVisible();
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirm).toBeHidden();

  await page.reload();
  await expect(grid(page).locator('tbody tr').filter({ hasText: doomed })).toHaveCount(0);
});
