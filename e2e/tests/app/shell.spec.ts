import { test, expect } from '@playwright/test';

test.describe('Sidebar rail', () => {
  test('collapses to icons, keeps every destination reachable and remembers the choice', async ({ page }) => {
    await page.goto('files');
    const sidebar = page.getByRole('navigation').first();
    expect((await sidebar.boundingBox())?.width).toBe(280);
    await expect(sidebar.getByText('STORAGES')).toBeVisible();
    await expect(sidebar.getByText('12.4 GB of 100 GB used')).toBeVisible();

    await page.getByRole('button', { name: 'Collapse menu' }).click();
    expect((await sidebar.boundingBox())?.width).toBe(76);
    // The labels leave the screen but not the accessibility tree.
    await expect(sidebar.getByText('STORAGES')).toHaveCount(0);
    await expect(sidebar.getByText('12.4 GB of 100 GB used')).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Starred' })).toBeVisible();

    await sidebar.getByRole('link', { name: 'Trash' }).click();
    await expect(page).toHaveURL(/\/app\/trash$/);

    await page.reload();
    expect((await page.getByRole('navigation').first().boundingBox())?.width).toBe(76);

    await page.getByRole('button', { name: 'Expand menu' }).click();
    expect((await page.getByRole('navigation').first().boundingBox())?.width).toBe(280);
  });

  test('the New menu still works from the rail', async ({ page }) => {
    await page.goto('files');
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Folder', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'New folder' })).toBeVisible();
  });
});

test.describe('Load failures', () => {
  test('a URL naming a folder that is gone offers a retry instead of a blank page', async ({ page }) => {
    await page.goto('files/Nowhere');
    await expect(page.getByText('Folder not found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The shell stays usable around the failed listing.
    await page.getByRole('navigation').first().getByRole('link', { name: 'Starred' }).click();
    await expect(page.getByRole('heading', { name: 'Starred', level: 1 })).toBeVisible();
  });
});
