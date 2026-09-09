import { test, expect } from '@playwright/test';
import { countIn } from '../../helpers/mockTree';

/** Cut and paste is a move in two steps; copy and paste is a duplicate in two steps. */
test.describe('Cut and paste', () => {
  test('the keyboard cuts a selection and pastes it into the folder that is open', async ({ page }) => {
    await page.goto('files?view=list');
    const rows = page.getByRole('grid').locator('tbody tr');
    await rows.filter({ hasText: 'README.md' }).click();
    await rows.filter({ hasText: 'app.ts' }).click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('ControlOrMeta+x');

    await page.getByRole('navigation', { name: 'Location' }).getByRole('button', { name: 'Subfolders' }).click();
    await page.getByRole('menu', { name: 'Subfolders' }).getByRole('menuitem', { name: 'Design', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/files\/demo\/Design$/);

    await page.getByRole('grid').click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.getByText('2 items moved to Design')).toBeVisible();
    await expect(rows.filter({ hasText: 'README.md' })).toHaveCount(1);
  });

  test('the menus offer Cut and Paste, and Paste waits for something to paste', async ({ page }) => {
    await page.goto('files/demo/Design?view=list');
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
    await expect(page.getByRole('grid').locator('tbody tr')).toHaveCount(countIn('Design'));
  });

  test('Ctrl+C then Ctrl+V duplicates in place, and the copy is named after the original', async ({ page }) => {
    await page.goto('files/demo/Design?view=list');
    const rows = page.getByRole('grid').locator('tbody tr');
    await rows.filter({ hasText: 'logo.svg' }).click();
    await page.keyboard.press('ControlOrMeta+c');
    // A copied row is not dimmed: the original is staying exactly where it is.
    await expect(rows.filter({ hasText: 'logo.svg' })).not.toHaveClass(/opacity-50/);

    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.getByText('“logo.svg” copied to Design')).toBeVisible();
    await expect(rows.filter({ hasText: 'logo.svg', hasNotText: 'copy' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'logo-copy.svg' })).toHaveCount(1);
  });

  test('Ctrl+Z takes back the paste and the trash, Ctrl+Shift+Z puts them back', async ({ page }) => {
    await page.goto('files/demo/Design?view=list');
    const rows = page.getByRole('grid').locator('tbody tr');

    // Paste, then undo it: the copy goes to the trash it came from nowhere into.
    await rows.filter({ hasText: 'logo.svg' }).click();
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(rows.filter({ hasText: 'logo-copy.svg' })).toHaveCount(1);
    await page.getByRole('grid').click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rows.filter({ hasText: 'logo-copy.svg' })).toHaveCount(0);

    // Trash, then undo it. The row comes back where it was.
    await rows.filter({ hasText: 'logo.svg' }).click();
    await page.keyboard.press('Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
    await expect(rows.filter({ hasText: 'logo.svg' })).toHaveCount(0);
    await page.getByRole('grid').click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rows.filter({ hasText: 'logo.svg' })).toHaveCount(1);

    // Ctrl+Shift+Z puts that same step back.
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(rows.filter({ hasText: 'logo.svg' })).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rows.filter({ hasText: 'logo.svg' })).toHaveCount(1);

    // Only one step is kept: a second Ctrl+Z is a no-op, not a jump further back to the paste.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(rows.filter({ hasText: 'logo-copy.svg' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'logo.svg' })).toHaveCount(1);
  });

  test('the bare R key refreshes the listing without reloading the page', async ({ page }) => {
    await page.goto('files/demo/Design?view=list');
    await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
    await page.getByRole('grid').click();
    await page.keyboard.press('r');
    await expect(page.getByRole('grid').locator('tbody tr').first()).toBeVisible();
    // A page reload would have wiped this; the listing refreshed in place.
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  });
});
