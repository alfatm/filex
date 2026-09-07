import { test, expect, type Page } from '@playwright/test';

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Location' });

/** Creates a folder in the open folder and steps into it. */
async function createAndEnter(page: Page, name: string) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).dblclick();
  await expect(crumbs(page).getByRole('heading', { name })).toBeVisible();
}

test.describe('Breadcrumbs', () => {
  test('the chain names every folder above the open one and each crumb navigates', async ({ page }) => {
    await page.goto('files/Design');
    const bar = crumbs(page);
    await expect(bar.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();

    // The parent is a button, the open folder is the heading.
    await bar.getByRole('button', { name: 'demo', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/files$/);
    await expect(bar.getByRole('heading', { name: 'demo', level: 1 })).toBeVisible();

    await page.getByRole('group', { name: 'Folders' }).getByRole('option', { name: /^Design\b/ }).dblclick();
    await bar.getByRole('button', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/app\/files$/);
  });

  test('the trailing chevron descends into a subfolder, and says so when there is none', async ({ page }) => {
    await page.goto('files');
    await crumbs(page).getByRole('button', { name: 'Subfolders' }).click();
    const menu = page.getByRole('menu', { name: 'Subfolders' });
    await expect(menu.getByRole('menuitem', { name: 'Photos' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Design', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/files\/Design$/);

    // Design holds files only.
    await crumbs(page).getByRole('button', { name: 'Subfolders' }).click();
    await expect(page.getByRole('menu', { name: 'Subfolders' }).getByRole('menuitem', { name: 'No subfolders' })).toBeVisible();
  });

  test('a long chain folds its middle behind a menu', async ({ page }) => {
    await page.goto('files/Design');
    await createAndEnter(page, 'Nested');
    await createAndEnter(page, 'Deeper');

    const bar = crumbs(page);
    // demo … Nested / Deeper: only the folded crumb left the bar.
    await expect(bar.getByRole('button', { name: 'demo', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Design', exact: true })).toHaveCount(0);
    await expect(bar.getByRole('button', { name: 'Nested', exact: true })).toBeVisible();
    await expect(bar.getByRole('heading', { name: 'Deeper' })).toBeVisible();

    await bar.getByRole('button', { name: 'More folders' }).click();
    await page.getByRole('menu', { name: 'More folders' }).getByRole('menuitem', { name: 'Design' }).click();
    await expect(page).toHaveURL(/\/app\/files\/Design$/);
    await expect(bar.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
  });
});
