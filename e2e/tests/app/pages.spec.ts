import { test, expect, type Page } from '@playwright/test';

/**
 * Home / Recent / Shared with me / Trash (spec §7). The shared-with-me nodes are dated relative to "now"
 * (they feed Recent's "Today" / "Yesterday"), so the page clock is pinned to keep the groups deterministic.
 */
const FIXED_TIME = '2026-07-10T16:00:00Z';

function rows(page: Page) {
  return page.getByRole('grid').locator('tbody tr');
}

test.describe('Pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
  });

  test('Home: storage card, recent files and starred items', async ({ page }) => {
    await page.goto('home');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    for (const name of ['Storages', 'Recent', 'Starred']) {
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    }
    const storage = page.getByRole('main').getByRole('link', { name: /demo/ });
    await expect(storage).toContainText('12.4 GB of 100 GB used');

    const recent = page.getByRole('listbox', { name: 'Recent' });
    await expect(recent.getByRole('option')).toHaveCount(5);
    await expect(recent.getByRole('option').first()).toContainText('Q3 report.pdf');
    const starred = page.getByRole('listbox', { name: 'Starred' });
    await expect(starred.getByRole('option')).toHaveCount(3);
    await expect(starred.getByRole('option', { name: /^Photos/ })).toBeVisible();
    await expect(starred.getByRole('option', { name: /mountains\.jpg/ })).toBeVisible();
    await expect(starred.getByRole('option', { name: /UI Design\.fig/ })).toBeVisible();

    await storage.click();
    await expect(page).toHaveURL(/\/app\/files$/);
  });

  // A row picked on a listing beside the tree describes a node like any other; the panel has to say where that
  // node actually LIVES, which is nowhere near the folder the user last had open.
  test('Recent: selecting a row opens the details panel with the file\u2019s own location', async ({ page }) => {
    await page.goto('recent');
    const panel = page.getByRole('complementary', { name: 'Details' });
    await expect(panel).toBeHidden();

    await page.getByRole('row', { name: /Brand Guidelines\.pdf/ }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Brand Guidelines.pdf' })).toBeVisible();
    await expect(panel.getByText('/demo/Design')).toBeVisible();

    // A second selection turns it back off: the panel describes one node, not a set.
    await page.getByRole('row', { name: /README\.md/ }).first().click({ modifiers: ['ControlOrMeta'] });
    await expect(panel).toBeHidden();
  });

  test('Recent: newest first, grouped by day, no sort control', async ({ page }) => {
    await page.goto('recent');
    await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
    const headings = page.getByRole('grid').locator('tbody tr').filter({ hasNot: page.locator('[data-id]') }).filter({ has: page.locator('td[colspan]') });
    // Root files carry the reference dates; the files inside each folder are dated hourly below their folder's date.
    await expect(headings).toHaveText([
      'Today',
      'Yesterday',
      'Jul 8, 2026',
      'Jul 7, 2026',
      'Jul 6, 2026',
      'Jul 5, 2026',
      'Jul 3, 2026',
      'Jul 1, 2026',
      'Jun 28, 2026',
      'Jun 27, 2026',
      'Jun 20, 2026',
      'Jun 19, 2026',
      'Jun 18, 2026',
      'Jun 14, 2026',
      'Jun 13, 2026',
      'Jun 10, 2026',
      'Jun 5, 2026',
    ]);
    const files = page.locator('tbody tr[data-id]');
    await expect(files.first()).toContainText('Q3 report.pdf');
    await expect(files.nth(1)).toContainText('README.md');
    // Assets beyond the reference set are dated below them, in the order the generator walked the tree.
    await expect(files.nth(2)).toContainText('Mechanical UI KIT 1.0 (Community).fig');
    await expect(files.nth(3)).toContainText('Roadmap.md');
    await expect(page.getByRole('button', { name: 'Sort by' })).toHaveCount(0);
  });

  test('Shared with me: "Shared by" and "Shared on" columns', async ({ page }) => {
    await page.goto('shared');
    await expect(page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
    const grid = page.getByRole('grid');
    for (const name of ['Name', 'Shared by', 'Shared on', 'File size']) {
      await expect(grid.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).filter({ hasText: 'Q3 report.pdf' })).toContainText('Alice Johnson');
    await expect(rows(page).filter({ hasText: 'Q3 report.pdf' })).toContainText('Jul 10, 2026, 02:00 PM');
    await expect(rows(page).filter({ hasText: 'Brand assets' })).toContainText('Marcus Lee');
  });

  test('Trash: banner, Deleted / Original location columns, Empty trash confirm', async ({ page }) => {
    await page.goto('trash?demo=trash');
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await expect(page.getByText('Items in trash are deleted forever after 30 days')).toBeVisible();
    const grid = page.getByRole('grid');
    for (const name of ['Deleted', 'Original location', 'File size']) {
      await expect(grid.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).filter({ hasText: 'Archive' })).toContainText('/demo');
    await expect(rows(page).filter({ hasText: 'data.csv' })).toContainText('Jul 10, 2026, 04:00 PM');

    const emptyButton = page.getByRole('button', { name: 'Empty trash' });
    await emptyButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Empty trash?' })).toBeVisible();
    // Both the footer button and the X carry the name "Cancel"; the footer one has it as text.
    await dialog.getByText('Cancel', { exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(rows(page)).toHaveCount(2);

    await emptyButton.click();
    await dialog.getByRole('button', { name: 'Empty trash' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Trash emptied')).toBeVisible();
    await expect(page.getByText('Trash is empty')).toBeVisible();
    await expect(emptyButton).toBeDisabled();
  });
});
