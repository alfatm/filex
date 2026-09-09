import { test, expect } from '@playwright/test';

// The mock storage (app/src/data/mock/dataset.ts) holds 8 folders and 8 files at the root.
const FOLDER_COUNT = 8;
const FILE_COUNT = 9;

test.describe('My files — grid view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('files');
  });

  test('sidebar navigation and both card sections render', async ({ page }) => {
    const nav = page.getByRole('navigation');
    for (const name of ['Home', 'My files', 'Shared with me', 'Recent', 'Starred', 'Trash']) {
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    }
    // The storage entry and the quota footer come from the mock storage "demo".
    await expect(nav.getByRole('link', { name: 'demo' })).toBeVisible();
    await expect(nav.getByText('12.4 GB of 100 GB used')).toBeVisible();

    await expect(page.getByRole('group', { name: 'Folders' }).getByRole('option')).toHaveCount(FOLDER_COUNT);
    await expect(page.getByRole('group', { name: 'Files' }).getByRole('option')).toHaveCount(FILE_COUNT);
  });

  test('opening Design lists the 8 files of the demo asset tree with real thumbnails', async ({ page }) => {
    await page.getByRole('group', { name: 'Folders' }).getByRole('option', { name: /^Design\b/ }).dblclick();
    await expect(page).toHaveURL(/\/app\/files\/demo\/Design$/);
    await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Folders' })).toHaveCount(0);
    const files = page.getByRole('group', { name: 'Files' }).getByRole('option');
    // Default sort is modified desc: the children are dated hourly below the folder's date, in tree order.
    await expect(files).toHaveText([
      /^Brand Guidelines\.pdf/,
      /^animation\.gif/,
      /^dashboard\.png/,
      /^file-browser\.jpg/,
      /^illustration\.webp/,
      /^logo\.svg/,
      /^source-design\.psd/,
      /^wireframe\.png/,
    ]);
    // The six images render the served file; the PDF and the PSD keep their placeholder / empty area.
    const thumbs = files.locator('img[src*="/demo-assets/Design/"]');
    await expect(thumbs).toHaveCount(6);
    await expect(thumbs.first()).toHaveJSProperty('complete', true);
    expect(await thumbs.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/app\/files\/demo$/);
    await expect(page.getByRole('group', { name: 'Folders' }).getByRole('option')).toHaveCount(FOLDER_COUNT);
  });

  test('starred items carry a star badge in both views', async ({ page }) => {
    const folders = page.getByRole('group', { name: 'Folders' });
    await expect(folders.getByRole('option', { name: /^Photos\b/ }).getByRole('img', { name: 'Starred' })).toBeVisible();
    await expect(folders.getByRole('option', { name: /^Code\b/ }).getByRole('img', { name: 'Starred' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Files' }).getByRole('option', { name: /mountains\.jpg/ }).getByRole('img', { name: 'Starred' })).toBeVisible();

    await page.getByRole('radio', { name: 'List view' }).click();
    const rows = page.getByRole('grid').locator('tbody tr');
    await expect(rows.filter({ has: page.getByText('Photos', { exact: true }) }).getByRole('img', { name: 'Starred' })).toBeVisible();
    await expect(rows.filter({ has: page.getByText('Code', { exact: true }) }).getByRole('img', { name: 'Starred' })).toHaveCount(0);
  });

  test('selecting Design and toggling Info opens the details panel', async ({ page }) => {
    const design = page.getByRole('group', { name: 'Folders' }).getByRole('option', { name: /^Design\b/ });
    await design.click();
    await expect(design).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('option', { selected: true })).toHaveCount(1);

    // The details panel is open by default and follows the selection.
    const info = page.getByRole('button', { name: 'Details', exact: true });
    await expect(info).toHaveAttribute('aria-pressed', 'true');
    const panel = page.getByRole('complementary');
    await expect(panel.getByRole('heading', { name: 'Design' })).toBeVisible();
    await expect(panel.getByText('Folder • 8 items')).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');

    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    await expect(info).toHaveAttribute('aria-pressed', 'false');
    // Closing the panel does not drop the selection.
    await expect(design).toHaveAttribute('aria-selected', 'true');

    await info.click();
    await expect(info).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('heading', { name: 'Design' })).toBeVisible();
  });
});
