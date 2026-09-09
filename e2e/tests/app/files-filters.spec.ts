import { test, expect, type Page } from '@playwright/test';

/**
 * Filter chips above the listings. The store hands the filter to the repository, so every pick is a reload —
 * these tests assert the listing that comes back, not a client-side narrowing of what was already on screen.
 */
const chips = (page: Page, name: string) => page.getByRole('group', { name: 'Filters' }).getByRole('button', { name, exact: true });

test.describe('Listing filters', () => {
  test('Type narrows the folder listing to files of that group', async ({ page }) => {
    await page.goto('files?view=list');
    const rows = page.getByRole('grid').locator('tbody tr');
    await expect(rows).toHaveCount(17);

    await chips(page, 'Type').click();
    const menu = page.getByRole('menu', { name: 'Type' });
    await expect(menu.getByRole('menuitemradio', { name: 'Any file type' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: 'Images' }).click();

    await expect(rows).toHaveCount(2);
    await expect(rows).toContainText([/mountains\.jpg/, /beach\.png/]);
    // The chip now reads the chosen value and marks itself active; folders are gone with it.
    const chip = chips(page, 'Images');
    await expect(chip).toBeVisible();
    await expect(chips(page, 'Type')).toHaveCount(0);

    await chip.click();
    await page.getByRole('menu', { name: 'Type' }).getByRole('menuitemradio', { name: 'Any file type' }).click();
    await expect(rows).toHaveCount(17);
  });

  test('an empty result offers a way back', async ({ page }) => {
    await page.goto('files?view=list');
    await chips(page, 'Size').click();
    await page.getByRole('menu', { name: 'Size' }).getByRole('menuitemradio', { name: 'Large' }).click();

    await expect(page.getByRole('grid')).toHaveCount(0);
    await expect(page.getByText('No matching items')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('grid').locator('tbody tr')).toHaveCount(17);
  });

  test('People filters Shared with me down to one owner', async ({ page }) => {
    await page.goto('shared');
    const rows = page.getByRole('grid').locator('tbody tr');
    const before = await rows.count();

    await chips(page, 'People').click();
    const menu = page.getByRole('menu', { name: 'People' });
    await expect(menu.getByRole('menuitemradio', { name: 'You' })).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Marcus Lee' }).click();

    await expect(rows).not.toHaveCount(before);
    // Shared with me shows the sharer in its first column after the name.
    await expect(rows.filter({ hasNotText: 'Marcus Lee' })).toHaveCount(0);
  });

  test('Modified uses the same windows as advanced search', async ({ page }) => {
    // The dataset is dated around July 2026, so the window is measured from a pinned clock.
    await page.clock.setFixedTime('2026-07-10T16:00:00Z');
    await page.goto('files?view=list');
    await chips(page, 'Modified').click();
    await page.getByRole('menu', { name: 'Modified' }).getByRole('menuitemradio', { name: 'Last 7 days' }).click();

    const rows = page.getByRole('grid').locator('tbody tr');
    await expect(rows).toHaveCount(10);
    // Folders survive a date filter, unlike a type or size one.
    await expect(rows.filter({ hasText: 'Code' })).toHaveCount(1);
  });

  // The filter is session state: it follows the user into the next folder, and a reload starts clean.
  test('the filter follows navigation into a subfolder', async ({ page }) => {
    await page.goto('files');
    await chips(page, 'Type').click();
    await page.getByRole('menu', { name: 'Type' }).getByRole('menuitemradio', { name: 'Images' }).click();
    await expect(page.getByRole('group', { name: 'Folders' })).toHaveCount(0);

    await page.goto('files/demo/Design');
    await expect(chips(page, 'Type')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Files' }).getByRole('option')).toHaveCount(8);
  });
});
