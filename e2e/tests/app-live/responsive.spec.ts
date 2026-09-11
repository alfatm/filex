import { test, expect, type Page } from '@playwright/test';

/**
 * §23: the app at tablet and phone widths. The audit found no overflow anywhere — but also no way to reach a
 * row's actions (right-click did nothing at 834 and 390 px), a rename dialog that did not open at 390, a dialog
 * drawn with zero height off the bottom of the viewport at 834, and a sidebar that stayed expanded at 390 and ate
 * the width.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Responsive E2E';
const FILE = 'r-one.txt';

const TABLET = { width: 834, height: 1112 };
const PHONE = { width: 390, height: 844 };

test.describe.configure({ mode: 'serial' });

function row(page: Page, name: string) {
  return page.getByRole('grid').locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) });
}

async function open(page: Page) {
  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  await expect(row(page, FILE)).toBeVisible();
}

test('the fixture: a folder with one file', async ({ page }) => {
  await page.goto(`files/${encodeURIComponent(DRIVE)}`);
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();

  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles({ name: FILE, mimeType: 'text/plain', buffer: Buffer.from('body\n') });
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 60_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
});

for (const [label, viewport] of [['tablet', TABLET], ['phone', PHONE]] as const) {
  test.describe(`at ${label} width`, () => {
    test.use({ viewport });

    test('a row\'s actions are reachable, and the dialog they open is on screen', async ({ page }) => {
      await open(page);

      // Right-click first: the audit reported it dead at both widths. It is not the important half — a touch
      // screen has no right button — but it is the half that was claimed broken.
      // On the name cell rather than the row: a row's box can start under the collapsed sidebar once the table
      // is scrolled, and Playwright aims at the centre of what it is given.
      await row(page, FILE).getByText(FILE, { exact: true }).click({ button: 'right' });
      await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
      await page.keyboard.press('Escape');

      await row(page, FILE).getByRole('button', { name: 'More' }).click();
      const menu = page.getByRole('menu', { name: 'More' });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box, 'the menu has no box').not.toBeNull();
      expect(box!.height, 'the menu was drawn with no height').toBeGreaterThan(0);
      expect(box!.y + box!.height, 'the menu runs off the bottom of the viewport').toBeLessThanOrEqual(viewport.height);
      expect(box!.x + box!.width, 'the menu runs off the right of the viewport').toBeLessThanOrEqual(viewport.width);

      await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Rename' })).toBeVisible();
      // The audit's tablet finding was a dialog at y=1112 with height 0 — drawn, but off the bottom with nothing
      // in it. So the controls a person has to reach are measured, not the wrapper.
      for (const control of [dialog.getByRole('textbox', { name: 'Rename' }), dialog.getByRole('button', { name: 'Rename' })]) {
        const cbox = await control.boundingBox();
        expect(cbox, 'the control has no box at all').not.toBeNull();
        expect(cbox!.height, 'the control was drawn with no height').toBeGreaterThan(0);
        expect(cbox!.y, 'the control sits below the bottom of the viewport').toBeLessThan(viewport.height);
        expect(cbox!.x + cbox!.width, 'the control runs off the right of the viewport').toBeLessThanOrEqual(viewport.width);
      }
      await page.keyboard.press('Escape');
    });

    test('nothing scrolls sideways', async ({ page }) => {
      await open(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'the page scrolls horizontally').toBeLessThanOrEqual(0);
    });
  });
}

test.describe('at phone width', () => {
  test.use({ viewport: PHONE });

  test('the sidebar does not eat the screen', async ({ page }) => {
    await open(page);
    const sidebar = page.getByRole('navigation').first();
    const box = await sidebar.boundingBox();
    // Collapsed, or off-screen behind a toggle: either way it may not take a third of a 390 px screen.
    expect(box === null || box.width <= PHONE.width / 3, `the sidebar is ${box?.width}px wide`).toBe(true);
  });
});
