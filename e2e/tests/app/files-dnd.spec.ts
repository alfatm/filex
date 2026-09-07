import { test, expect, type Page } from '@playwright/test';

/** A DataTransfer holding one file, as the browser builds for a drop from the OS. */
function osFiles(page: Page, name: string) {
  return page.evaluateHandle((fileName) => {
    const data = new DataTransfer();
    data.items.add(new File(['hello'], fileName, { type: 'text/plain' }));
    return data;
  }, name);
}

test.describe('Drag and drop', () => {
  test('dragging a file onto a folder card moves it', async ({ page }) => {
    await page.goto('files');
    const file = page.getByRole('option', { name: /^README\.md/ });
    const folder = page.getByRole('option', { name: /^Documents\b/ });
    await file.dragTo(folder);

    await expect(page.getByText('“README.md” moved to Documents')).toBeVisible();
    await expect(page.getByRole('option', { name: /^README\.md/ })).toHaveCount(0);
    await folder.dblclick();
    await expect(page.getByRole('option', { name: /^README\.md/ })).toBeVisible();
  });

  test('a multi-selection travels together', async ({ page }) => {
    await page.goto('files?view=list');
    const rows = page.getByRole('grid').locator('tbody tr');
    await rows.filter({ hasText: 'README.md' }).click();
    await rows.filter({ hasText: 'app.ts' }).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByRole('row', { selected: true })).toHaveCount(2);

    await rows.filter({ hasText: 'app.ts' }).dragTo(rows.filter({ hasText: 'Documents' }));
    await expect(page.getByText('2 items moved to Documents')).toBeVisible();
    await expect(rows).toHaveCount(15);
  });

  test('a breadcrumb above the open folder accepts a drop', async ({ page }) => {
    await page.goto('files/Design');
    const crumb = page.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'demo', exact: true });
    await page.getByRole('option', { name: /^logo\.svg/ }).dragTo(crumb);
    await expect(page.getByText('“logo.svg” moved to demo')).toBeVisible();
    await expect(page.getByRole('option', { name: /^logo\.svg/ })).toHaveCount(0);
  });

  test('files dropped from the OS upload into the open folder', async ({ page }) => {
    await page.goto('files/Design');
    const data = await osFiles(page, 'dropped.txt');
    const main = page.locator('main');

    await main.dispatchEvent('dragover', { dataTransfer: data });
    await expect(page.getByText('Drop files to upload to “Design”')).toBeVisible();

    await main.dispatchEvent('drop', { dataTransfer: data });
    await expect(page.getByText('Drop files to upload to “Design”')).toHaveCount(0);
    await expect(page.getByRole('option', { name: /^dropped\.txt/ })).toBeVisible({ timeout: 10_000 });
  });

  test('files dropped on a folder card upload into that folder', async ({ page }) => {
    await page.goto('files');
    const data = await osFiles(page, 'into-code.txt');
    const folder = page.getByRole('option', { name: /^Code\b/ });

    await folder.dispatchEvent('dragover', { dataTransfer: data });
    await folder.dispatchEvent('drop', { dataTransfer: data });
    await expect(page.getByRole('option', { name: /^into-code\.txt/ })).toHaveCount(0);

    await folder.dblclick();
    await expect(page.getByRole('option', { name: /^into-code\.txt/ })).toBeVisible({ timeout: 10_000 });
  });
});
