import { test, expect, type Page } from '@playwright/test';

/** The preview modal over the real demo assets: renderers per file kind, ← → navigation, download links, Recent. */

function card(page: Page, name: string) {
  return page.getByRole('group', { name: 'Files' }).getByRole('option', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
}

test.describe('Preview', () => {
  test('dblclick opens the image; → shows app.ts as text with line numbers; Esc closes', async ({ page }) => {
    await page.goto('files');
    await card(page, 'mountains.jpg').dblclick();
    const dialog = page.getByRole('dialog', { name: 'mountains.jpg' });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole('img', { name: 'mountains.jpg' });
    await expect(image).toBeVisible();
    await expect(image).toHaveJSProperty('naturalWidth', 1440);
    await expect(dialog.getByRole('button', { name: 'Previous file' })).toBeEnabled();

    await page.keyboard.press('ArrowRight');
    const next = page.getByRole('dialog', { name: 'app.ts' });
    await expect(next).toBeVisible();
    const lines = next.locator('pre li');
    await expect(lines.first()).toContainText('1');
    await expect(lines.first()).toContainText('export interface FileEntry');
    expect(await lines.count()).toBeGreaterThan(10);
    await expect(next.locator('pre li').nth(9).locator('span').first()).toHaveText('10');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('a PDF renders in an iframe', async ({ page }) => {
    await page.goto('files?modal=preview&select=overview.pdf');
    const dialog = page.getByRole('dialog', { name: 'overview.pdf' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('iframe[title="overview.pdf"]')).toHaveAttribute('src', /\/app\/demo-assets\/overview\.pdf$/);
  });

  test('a CSV renders as a table with header cells', async ({ page }) => {
    await page.goto('files?modal=preview&select=data.csv');
    const dialog = page.getByRole('dialog', { name: 'data.csv' });
    await expect(dialog).toBeVisible();
    const headers = dialog.getByRole('columnheader');
    // The content is fetched after the dialog opens: wait for the first header cell before counting.
    await expect(headers.first()).toHaveText('id');
    expect(await headers.count()).toBeGreaterThan(1);
    expect(await dialog.getByRole('row').count()).toBeGreaterThan(2);
  });

  test('a file without a renderer shows the download card', async ({ page }) => {
    await page.goto('files?modal=preview&select=UI Design.fig');
    const dialog = page.getByRole('dialog', { name: 'UI Design.fig' });
    await expect(dialog.getByText('No preview available')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Download' })).toHaveCount(2);
  });

  test('Download is a real link and the server answers with an attachment', async ({ page }) => {
    await page.goto('files?modal=preview&select=README.md');
    const dialog = page.getByRole('dialog', { name: 'README.md' });
    const link = dialog.getByRole('link', { name: 'Download' });
    await expect(link).toHaveAttribute('download', 'README.md');
    await expect(link).toHaveAttribute('href', /\/app\/demo-assets\/README\.md\?download=1$/);
    const response = await page.request.get((await link.getAttribute('href'))!);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-disposition']).toMatch(/^attachment/);
    expect(response.headers()['content-type']).toContain('text/markdown');
  });

  test('Open / Preview in the ⋮ menu and Enter open the preview; folders keep Preview disabled', async ({ page }) => {
    await page.goto('files?view=list');
    const grid = page.getByRole('grid');
    const row = grid.locator('tbody tr').filter({ has: page.getByText('beach.png', { exact: true }) });
    await row.getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu', { name: 'More' });
    for (const name of ['Open', 'Preview', 'Download']) {
      await expect(menu.getByRole('menuitem', { name, exact: true })).not.toHaveAttribute('aria-disabled', 'true');
    }
    await menu.getByRole('menuitem', { name: 'Preview' }).click();
    await expect(page.getByRole('dialog', { name: 'beach.png' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await row.click();
    await grid.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'beach.png' })).toBeVisible();
    await page.keyboard.press('Escape');

    await grid.locator('tbody tr').filter({ has: page.getByText('Design', { exact: true }) }).getByRole('button', { name: 'More' }).click();
    await expect(menu.getByRole('menuitem', { name: 'Preview' })).toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Download' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('Recent lists the opened file first', async ({ page }) => {
    await page.goto('files');
    await card(page, 'mountains.jpg').dblclick();
    await expect(page.getByRole('dialog', { name: 'mountains.jpg' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('navigation').getByRole('link', { name: 'Recent', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
    const rows = page.locator('tbody tr[data-id]');
    await expect(rows.first()).toContainText('mountains.jpg');
    await expect(rows.nth(1)).toContainText('Q3 report.pdf');
  });
});
