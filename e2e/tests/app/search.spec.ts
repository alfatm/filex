import { test, expect, type Page } from '@playwright/test';

/** Ctrl+K focuses the topbar box; the sliders button beside it opens the Advanced search modal with the text prefilled. */
async function openAdvancedSearch(page: Page, text: string) {
  const box = page.getByRole('banner').getByRole('searchbox', { name: 'Search' });
  await page.keyboard.press('Control+k');
  await expect(box).toBeFocused();
  await box.fill(text);
  await page.getByRole('banner').getByRole('button', { name: 'Advanced search' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Advanced search' })).toBeVisible();
  return dialog;
}

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('files');
  });

  test('Enter in the topbar box runs a quick search without opening the modal', async ({ page }) => {
    const box = page.getByRole('banner').getByRole('searchbox', { name: 'Search' });
    await page.keyboard.press('Control+k');
    await box.fill('design');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\/search\?q=design$/);
    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.getByRole('row').nth(1)).toBeVisible();
  });

  test('the sliders button opens Advanced search with the query prefilled and live results', async ({ page }) => {
    const dialog = await openAdvancedSearch(page, 'design');
    const query = dialog.getByRole('searchbox', { name: 'Search' });
    await expect(query).toHaveValue('design');
    await expect(query).toBeFocused();

    // Opened by a user the form is neutral: no tags, no path; the reference tags/path exist only for screenshots.
    await expect(dialog.getByRole('button', { name: /^Remove tag/ })).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Path' })).toHaveValue('');
    await expect(dialog.getByRole('radio', { name: 'Current folder: demo' })).toBeChecked();

    // "design" matches the Design folder, its two indexed files, the 8 files inside it (by path), UI Design.fig and
    // two files whose text mentions it; the count is the real one.
    await expect(dialog.getByText('14 matching items')).toBeVisible();
    const results = dialog.getByRole('list').last().getByRole('listitem');
    await expect(results.filter({ hasText: 'Design' }).first()).toContainText('8 items');
    const overview = results.filter({ hasText: 'overview.pdf' });
    await expect(overview).toContainText('/demo/Design');
    await expect(overview.locator('mark').first()).toHaveText('design');
  });

  test('Search navigates to /search?q=design with a results table', async ({ page }) => {
    const dialog = await openAdvancedSearch(page, 'design');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/app\/search\?(?:.*&)?q=design(?:&|$)/);
    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.getByText('“design”')).toBeVisible();

    const table = page.getByRole('main').getByRole('table');
    for (const name of ['Name', 'Path', 'Match', 'Modified', 'Size']) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    const body = table.locator('tbody tr');
    await expect(body.first()).toContainText('Design');
    await expect(body.filter({ hasText: 'overview.pdf' })).toContainText('/demo/Design');
    await expect(body.filter({ hasText: 'overview.pdf' }).locator('mark').first()).toHaveText('design');
  });

  test('Cancel and Esc close the modal', async ({ page }) => {
    // Closing the modal navigates nowhere, so the address stays the one the test opened — no drive segment in it.
    let dialog = await openAdvancedSearch(page, 'design');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/app\/files$/);

    dialog = await openAdvancedSearch(page, 'design');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/app\/files$/);
  });

  test('/search?q=beach deep link runs the query from the URL', async ({ page }) => {
    await page.goto('search?q=beach');
    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.getByText('“beach”')).toBeVisible();
    // The indexed Design/beach.png, the root README (mentions "a beach photo"), the root beach.png and two Photos.
    await expect(page.getByText('5 matching items')).toBeVisible();
    const body = page.getByRole('main').getByRole('table').locator('tbody tr');
    await expect(body).toHaveCount(5);
    await expect(body.nth(0)).toContainText('beach.png');
    await expect(body.nth(0)).toContainText('/demo/Design');
    await expect(body.nth(2)).toContainText('beach.png');
    await expect(body.nth(3)).toContainText('beach-sunset.jpg');
    // The results page has no folder open, so the topbar still names the storage.
    await expect(page.getByRole('banner').getByRole('searchbox')).toHaveAttribute('placeholder', 'Search in demo…');
  });
});
