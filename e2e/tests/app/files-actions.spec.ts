import { test, expect, type Page } from '@playwright/test';

/** Mutations through the New menu, the item ⋮ menu, the Undo toast and the details panel (spec §7). */

/** The list row whose name cell reads exactly `name` ("Design" must not match "UI Design.fig"). */
function row(page: Page, name: string) {
  return page.getByRole('grid').locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) });
}

/** Opens the ⋮ menu of a list row and picks an entry. */
async function pickMenu(page: Page, name: string, entry: string) {
  await row(page, name).getByRole('button', { name: 'More' }).click();
  const menu = page.getByRole('menu', { name: 'More' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: entry, exact: true }).click();
  await expect(menu).toBeHidden();
}

test.describe('File actions', () => {
  test('New → New folder creates "Reports" in the open folder', async ({ page }) => {
    await page.goto('files');
    const newButton = page.getByRole('navigation').getByRole('button', { name: 'New' });
    await newButton.click();
    await expect(newButton).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: 'New' });
    // "File" is the only entry still waiting for a backend.
    await expect(menu.getByRole('menuitem', { name: 'Upload folder' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByRole('menuitem', { name: 'File', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await menu.getByRole('menuitem', { name: 'Folder', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeVisible();
    const input = dialog.getByRole('textbox', { name: 'New folder' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Untitled folder');
    await input.fill('Reports');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toBeHidden();
    const folders = page.getByRole('group', { name: 'Folders' });
    await expect(folders.getByRole('option', { name: /^Reports/ })).toBeVisible();
    await expect(folders.getByRole('option')).toHaveCount(9);
  });

  test('Rename via ⋮ and the repository rejects a name collision', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Design', 'Rename');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Rename' })).toBeVisible();
    const input = dialog.getByRole('textbox', { name: 'Rename' });
    await expect(input).toHaveValue('Design');
    await input.fill('Design v2');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Design v2')).toBeVisible();

    await pickMenu(page, 'Code', 'Rename');
    await dialog.getByRole('textbox', { name: 'Rename' }).fill('Design v2');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('An item with this name already exists');
    await dialog.getByText('Cancel', { exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Code')).toBeVisible();
  });

  test('Move: the storage picker and the folder filter narrow the destination tree', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Archive', 'Move to');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Move “Archive” to' })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Storage' })).toHaveValue('demo');
    const list = dialog.getByRole('listbox', { name: 'Destination folder' });
    // The tree: the root, then its folders; the moved folder and the current parent are not targets.
    await expect(list.getByRole('option', { name: 'demo' })).toBeDisabled();
    await expect(list.getByRole('option', { name: 'Archive' })).toBeDisabled();

    await dialog.getByRole('searchbox', { name: 'Filter folders' }).fill('doc');
    await expect(list.getByRole('option')).toHaveCount(1);
    await list.getByRole('option', { name: /^Documents/ }).click();
    await dialog.getByRole('button', { name: 'Move' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('“Archive” moved to Documents')).toBeVisible();
    await expect(row(page, 'Archive')).toHaveCount(0);
  });

  test('Move to trash offers Undo; Undo restores the item', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Archive', 'Move to trash');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Move to trash?' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Move to trash' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(page, 'Archive')).toHaveCount(0);

    const toast = page.getByText('“Archive” moved to trash');
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(toast).toBeHidden();
    await expect(page.getByText('“Archive” restored')).toBeVisible();
    await expect(row(page, 'Archive')).toBeVisible();
  });

  test('Restore from the Trash page via ⋮', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Archive', 'Move to trash');
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
    await expect(row(page, 'Archive')).toHaveCount(0);

    await page.getByRole('navigation').getByRole('link', { name: 'Trash', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await expect(row(page, 'Archive')).toContainText('/demo');
    await pickMenu(page, 'Archive', 'Restore');
    await expect(page.getByText('“Archive” restored')).toBeVisible();
    await expect(page.getByText('Trash is empty')).toBeVisible();

    // `?view=list` is remembered, so My files comes back as the table.
    await page.getByRole('navigation').getByRole('link', { name: 'My files', exact: true }).click();
    await expect(page.getByRole('columnheader', { name: 'Last modified' })).toBeVisible();
    await expect(row(page, 'Archive')).toBeVisible();
  });

  test('Add to starred via ⋮ shows the item on the Starred page', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Code', 'Add to starred');
    await expect(page.getByText('“Code” added to starred')).toBeVisible();

    await page.getByRole('navigation').getByRole('link', { name: 'Starred', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Starred' })).toBeVisible();
    await expect(row(page, 'Code')).toBeVisible();
    // Photos, mountains.jpg and UI Design.fig are starred in the mock; Code joins them.
    await expect(page.getByRole('grid').locator('tbody tr')).toHaveCount(4);
    // The starred item offers the opposite action now.
    await row(page, 'Code').getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Remove from starred' })).toBeVisible();
  });

  test('Move to via ⋮: Archive → Documents', async ({ page }) => {
    await page.goto('files?view=list');
    await expect(row(page, 'Documents')).toContainText('24 items');
    await pickMenu(page, 'Archive', 'Move to');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Move “Archive” to' })).toBeVisible();
    const targets = dialog.getByRole('listbox', { name: 'Destination folder' });
    // The moved folder and its current parent cannot be targets.
    await expect(targets.getByRole('option', { name: 'Archive' })).toBeDisabled();
    await expect(targets.getByRole('option', { name: 'demo' })).toBeDisabled();
    const move = dialog.getByRole('button', { name: 'Move', exact: true });
    await expect(move).toBeDisabled();
    await targets.getByRole('option', { name: 'Documents' }).click();
    await move.click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText('“Archive” moved to Documents')).toBeVisible();
    await expect(row(page, 'Archive')).toHaveCount(0);
    await expect(row(page, 'Documents')).toContainText('25 items');
  });

  test('Copy to via ⋮ leaves the original where it is', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Archive', 'Copy to');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Copy “Archive” to' })).toBeVisible();
    const targets = dialog.getByRole('listbox', { name: 'Destination folder' });
    // A folder still cannot be copied inside itself, but its current parent is a target: that duplicates it in place.
    await expect(targets.getByRole('option', { name: 'Archive' })).toBeDisabled();
    await expect(targets.getByRole('option', { name: 'demo' })).toBeEnabled();
    await targets.getByRole('option', { name: 'Documents' }).click();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText('“Archive” copied to Documents')).toBeVisible();
    await expect(row(page, 'Archive')).toHaveCount(1);
    await expect(row(page, 'Documents')).toContainText('25 items');
  });

  test('Share via ⋮ turns on link sharing and shows the URL row', async ({ page }) => {
    await page.goto('files?view=list');
    await pickMenu(page, 'Design', 'Share');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Share “Design”' })).toBeVisible();
    await expect(dialog.getByText('Only people with access can open')).toBeVisible();
    const toggle = dialog.getByRole('switch', { name: 'Link sharing' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByText(/^https:\/\/filex\.example\/s\//)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await expect(dialog.getByText('Anyone with the link can view')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
  });

  test('New → Upload files runs through the tray and lands in the open folder', async ({ page }) => {
    await page.goto('files?view=list');
    await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
    await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello filex') });

    const tray = page.getByRole('region', { name: /^Uploading|upload complete$/ });
    await expect(tray).toBeVisible();
    await expect(tray).toContainText('notes.txt');
    // The mock transfer takes ~1.5 s, then the file is added to the folder.
    await expect(tray.getByText('1 upload complete')).toBeVisible({ timeout: 10_000 });
    await expect(row(page, 'notes.txt')).toBeVisible();
    await expect(row(page, 'notes.txt')).toContainText('11 B');
    await tray.getByRole('button', { name: 'Close' }).click();
    await expect(tray).toBeHidden();
  });

  test('right-click opens the context menu on the row under the cursor and selects it', async ({ page }) => {
    await page.goto('files?view=list');
    await row(page, 'Code').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeVisible();
    await expect(row(page, 'Code')).toHaveAttribute('aria-selected', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Move to trash' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Preview' })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // The selection survives the menu; a right-click on another row moves it there.
    await expect(row(page, 'Code')).toHaveAttribute('aria-selected', 'true');
    await row(page, 'Design').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(row(page, 'Design')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'Code')).toHaveAttribute('aria-selected', 'false');
  });

  test('Create link in the details panel shows the URL row', async ({ page }) => {
    await page.goto('files?select=Design&panel=details');
    const panel = page.getByRole('complementary');
    await expect(panel.getByRole('heading', { name: 'Design' })).toBeVisible();
    await expect(panel.getByText('Not shared')).toBeVisible();

    await panel.getByRole('button', { name: 'Create link' }).click();
    await expect(panel.getByText(/^https:\/\/filex\.example\/s\//)).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy link' })).toBeVisible();
    await panel.getByRole('button', { name: 'Remove' }).click();
    await expect(panel.getByText('Not shared')).toBeVisible();
  });
});

test.describe('Listing menu', () => {
  test('right-click on empty surface offers the listing actions', async ({ page }) => {
    // Design holds 8 rows in list view, so the lower half of the page is bare surface.
    await page.goto('files/Design?view=list');
    const bare = { button: 'right' as const, position: { x: 400, y: 700 } };
    await page.locator('main').click(bare);
    const menu = page.getByRole('menu', { name: 'Listing actions' });
    await expect(menu.getByRole('menuitem', { name: 'Deselect all', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await menu.getByRole('menuitem', { name: 'Select all', exact: true }).click();
    await expect(page.getByRole('row', { selected: true })).toHaveCount(8);

    await page.locator('main').click(bare);
    await page.getByRole('menu', { name: 'Listing actions' }).getByRole('menuitem', { name: 'Deselect all', exact: true }).click();
    await expect(page.getByRole('row', { selected: true })).toHaveCount(0);
  });

  test('the grid ⋮ button opens the same menu and creates a folder', async ({ page }) => {
    await page.goto('files');
    await page.getByRole('button', { name: 'Listing actions' }).click();
    await page.getByRole('menu', { name: 'Listing actions' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('From the menu');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('option', { name: /^From the menu/ })).toBeVisible();
  });

  test('right-clicking a card still opens that item’s menu', async ({ page }) => {
    await page.goto('files');
    await page.getByRole('option', { name: /^Design\b/ }).click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(page.getByRole('menu', { name: 'Listing actions' })).toHaveCount(0);
  });
});
