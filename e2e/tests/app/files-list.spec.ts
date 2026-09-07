import { test, expect, type Page } from '@playwright/test';

const ROW_COUNT = 17;

function rows(page: Page) {
  return page.getByRole('grid').locator('tbody tr');
}

test.describe('My files — list view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('files');
    const listToggle = page.getByRole('radio', { name: 'List view' });
    await listToggle.click();
    await expect(listToggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Grid view' })).toHaveAttribute('aria-checked', 'false');
  });

  test('table header and row count', async ({ page }) => {
    const grid = page.getByRole('grid');
    for (const name of ['Name', 'Owner', 'Last modified', 'File size']) {
      await expect(grid.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    await expect(rows(page)).toHaveCount(ROW_COUNT);
  });

  test('checkbox selection, selection bar and Esc', async ({ page }) => {
    const first = rows(page).nth(0);
    const second = rows(page).nth(1);

    await first.getByRole('checkbox').click();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(1);
    // A single selection keeps the filter chips; the bar appears from two on.
    await expect(page.getByRole('toolbar')).toBeHidden();

    await second.getByRole('checkbox').click();
    await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(2);
    const bar = page.getByRole('toolbar', { name: '2 selected' });
    await expect(bar).toBeVisible();
    await expect(bar.getByText('2 selected')).toBeVisible();

    // Keys are handled on the grid container (spec §4), so put focus there before Esc.
    await page.getByRole('grid').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(0);
    await expect(bar).toBeHidden();
  });

  test('clicking the Name header sorts ascending', async ({ page }) => {
    const nameHeader = page.getByRole('columnheader', { name: 'Name', exact: true });
    // The default order is "last modified, newest first".
    await expect(page.getByRole('columnheader', { name: 'Last modified' })).toHaveAttribute('aria-sort', 'descending');
    await expect(rows(page).first()).toContainText('Code');

    await nameHeader.getByRole('button').click();
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    await expect(rows(page).first()).toContainText('Archive');
    // Folders stay ahead of files whatever the key.
    await expect(rows(page).nth(8)).toContainText('app.ts');
  });

  test('keyboard: arrows move the cursor, Space toggles, Ctrl+A selects all', async ({ page }) => {
    const grid = page.getByRole('grid');
    await grid.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');

    // Default order: Code (Jul 8), Design (Jul 1), … — the second row is Design.
    await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(1);
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(rows(page).nth(1)).toContainText('Design');
    await expect(grid).toHaveAttribute('aria-activedescendant', 'node-design');

    await page.keyboard.press('Control+a');
    await expect(page.locator('tbody tr[aria-selected="true"]')).toHaveCount(ROW_COUNT);
    await expect(page.getByRole('toolbar', { name: `${ROW_COUNT} selected` })).toBeVisible();
    await expect(page.getByRole('columnheader').first().getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });
});
