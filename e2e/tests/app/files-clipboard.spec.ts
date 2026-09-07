import { test, expect } from '@playwright/test';

/** Cut and paste is a move in two steps; copying is a separate feature and is not in the clipboard. */
test.describe('Cut and paste', () => {
  test('the keyboard cuts a selection and pastes it into the folder that is open', async ({ page }) => {
    await page.goto('files?view=list');
    const rows = page.getByRole('grid').locator('tbody tr');
    await rows.filter({ hasText: 'README.md' }).click();
    await rows.filter({ hasText: 'app.ts' }).click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('ControlOrMeta+x');

    await page.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'Subfolders' }).click();
    await page.getByRole('menu', { name: 'Subfolders' }).getByRole('menuitem', { name: 'Design', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/files\/Design$/);

    await page.getByRole('grid').click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.getByText('2 items moved to Design')).toBeVisible();
    await expect(rows.filter({ hasText: 'README.md' })).toHaveCount(1);
  });

  test('the menus offer Cut and Paste, and Paste waits for something to paste', async ({ page }) => {
    await page.goto('files/Design?view=list');
    const bare = { button: 'right' as const, position: { x: 400, y: 700 } };

    await page.locator('main').click(bare);
    await expect(page.getByRole('menu', { name: 'Listing actions' }).getByRole('menuitem', { name: 'Paste' })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    await page.getByRole('grid').locator('tbody tr').filter({ hasText: 'logo.svg' }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Cut' }).click();
    // A cut row stays in place, dimmed, until it lands somewhere.
    await expect(page.getByRole('grid').locator('tbody tr').filter({ hasText: 'logo.svg' })).toHaveClass(/opacity-50/);

    await page.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'demo', exact: true }).click();
    // The root fills the list view, so the same menu is reached through the grid's ⋮ button.
    await page.getByRole('radio', { name: 'Grid view' }).click();
    await page.getByRole('button', { name: 'Listing actions' }).click();
    await page.getByRole('menu', { name: 'Listing actions' }).getByRole('menuitem', { name: 'Paste' }).click();
    await expect(page.getByText('“logo.svg” moved to demo')).toBeVisible();
  });

  test('a folder cannot be pasted into itself', async ({ page }) => {
    await page.goto('files?view=list');
    // "UI Design.fig" also contains "Design": match the cell text exactly.
    const design = page.getByRole('grid').locator('tbody tr').filter({ has: page.getByText('Design', { exact: true }) });
    await design.click();
    await page.keyboard.press('ControlOrMeta+x');
    await design.dblclick();
    await page.getByRole('grid').click();
    await page.keyboard.press('ControlOrMeta+v');

    // Nothing moved and nothing threw: the clipboard is simply emptied.
    await expect(page.getByRole('heading', { name: 'Design', level: 1 })).toBeVisible();
    await expect(page.getByRole('grid').locator('tbody tr')).toHaveCount(8);
  });
});
