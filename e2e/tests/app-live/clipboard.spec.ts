import { test, expect, type Page } from '@playwright/test';

/**
 * Cut / Copy / Paste against a real server — the audit found the whole category dead: `Paste` stayed
 * `aria-disabled` in every listing, by menu and by keyboard alike.
 *
 * Grid view throughout: it is the only view whose listing menu has a control (`Listing actions`); in list view
 * the same menu is reachable only by right-clicking bare page surface, which is not something a spec can aim at.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const SRC = 'CB Src';
const DST = 'CB Dst';
const CUT_ITEM = 'cb-cut';
const COPY_ITEM = 'cb-copy';

test.describe.configure({ mode: 'serial' });

function card(page: Page, name: string) {
  return page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
}

async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const grid = page.getByRole('radio', { name: 'Grid view' });
  await expect(grid).toBeVisible();
  if ((await grid.getAttribute('aria-checked')) !== 'true') await grid.click();
  await expect(grid).toHaveAttribute('aria-checked', 'true');
}

async function pickItemMenu(page: Page, name: string, entry: string) {
  await card(page, name).getByRole('button', { name: 'More' }).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: entry, exact: true }).click();
}

/** The listing's own menu, and the state of its Paste entry — the single symptom the audit reported. */
async function listingMenu(page: Page) {
  await page.getByRole('button', { name: 'Listing actions' }).click();
  const menu = page.getByRole('menu', { name: 'Listing actions' });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Navigates WITHIN the app, the way a user does — `page.goto` is a full reload and would wipe the clipboard
 * store before the paste, which says nothing about the product.
 */
async function enter(page: Page, name: string) {
  await card(page, name).dblclick();
  await expect(page.getByRole('navigation', { name: 'Location' })).toContainText(name);
}

/** Back to the drive root through the breadcrumb — again in-app, for the same reason. */
async function toRoot(page: Page) {
  await page.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: DRIVE, exact: true }).click();
  await expect(card(page, SRC)).toBeVisible();
}

async function newFolder(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, name)).toBeVisible();
}

test('the fixture: two folders, each with one item to move around', async ({ page }) => {
  await open(page);
  await newFolder(page, SRC);
  await newFolder(page, DST);
  await open(page, SRC);
  await newFolder(page, CUT_ITEM);
  await newFolder(page, COPY_ITEM);
});

test('Copy then Paste in the SAME folder duplicates the item', async ({ page }) => {
  await open(page, SRC);
  await pickItemMenu(page, COPY_ITEM, 'Copy');

  const menu = await listingMenu(page);
  const paste = menu.getByRole('menuitem', { name: 'Paste', exact: true });
  await expect(paste, 'Paste is disabled right after a Copy, in the very folder the copy came from').not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await paste.click();

  await page.reload();
  await expect(page.getByText(COPY_ITEM, { exact: false }).first()).toBeVisible();
  // A copy alongside the original: the server picked the name, so only the count is asserted.
  await expect(page.getByRole('option')).toHaveCount(3);
});

test('Cut in one folder, Paste in another, by menu', async ({ page }) => {
  await open(page, SRC);
  await pickItemMenu(page, CUT_ITEM, 'Cut');
  await expect(card(page, CUT_ITEM)).toHaveClass(/opacity-50/);

  await toRoot(page);
  await enter(page, DST);
  const menu = await listingMenu(page);
  const paste = menu.getByRole('menuitem', { name: 'Paste', exact: true });
  await expect(paste, 'Paste is disabled in the destination folder after a Cut').not.toHaveAttribute('aria-disabled', 'true');
  await paste.click();

  await page.reload();
  await expect(card(page, CUT_ITEM)).toBeVisible();
  await open(page, SRC);
  await expect(card(page, CUT_ITEM)).toHaveCount(0);
});

test('Ctrl+C and Ctrl+V move through the same clipboard', async ({ page }) => {
  await open(page, DST);
  await card(page, CUT_ITEM).click();
  await page.keyboard.press('Control+c');

  await toRoot(page);
  await enter(page, SRC);
  const listing = page.getByRole('listbox');
  await listing.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+v');

  await expect(card(page, CUT_ITEM)).toBeVisible();
  await page.reload();
  await expect(card(page, CUT_ITEM)).toBeVisible();
});

test('Escape drops a pending cut', async ({ page }) => {
  await open(page, SRC);
  await pickItemMenu(page, CUT_ITEM, 'Cut');
  await expect(card(page, CUT_ITEM)).toHaveClass(/opacity-50/);

  await page.keyboard.press('Escape');
  await expect(card(page, CUT_ITEM)).not.toHaveClass(/opacity-50/);

  const menu = await listingMenu(page);
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toHaveAttribute('aria-disabled', 'true');
});
