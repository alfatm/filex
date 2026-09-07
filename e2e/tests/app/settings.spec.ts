import { test, expect } from '@playwright/test';

/** The user settings modal (app/src/features/settings/): opened from the topbar gear or the account menu. */
test.describe('User settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('files');
  });

  test('the gear and the account menu both open it, with every section listed', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'User settings' })).toBeVisible();
    const nav = dialog.getByRole('navigation', { name: 'User settings' });
    for (const name of ['Profile', 'Preferences', 'Notifications', 'Security', 'AI assistant']) {
      await expect(nav.getByRole('button', { name })).toBeVisible();
    }
    // The account fields come from the repository, not from the form's own defaults.
    await expect(dialog.getByRole('textbox', { name: 'Full name' })).toHaveValue('demo');
    await expect(dialog.getByText('demo@filex.local').first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'User settings' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'User settings' })).toBeVisible();
  });

  test('the theme applies on save and is discarded on cancel', async ({ page }) => {
    const html = page.locator('html');
    await expect(html).not.toHaveAttribute('data-theme', /.*/);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(html).not.toHaveAttribute('data-theme', /.*/);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    // The whole shell repaints, not just the modal.
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(21, 23, 28)');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('the language switch translates the shell and survives a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: 'Language' }).selectOption('ru');
    await page.getByRole('button', { name: 'Save changes' }).click();

    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Главная' })).toBeVisible();
    await page.reload();
    await expect(nav.getByRole('link', { name: 'Мои файлы' })).toBeVisible();
  });

  test('the compact list shortens the table rows', async ({ page }) => {
    await page.getByRole('radio', { name: 'List view' }).click();
    const row = page.getByRole('grid').locator('tbody tr').first();
    expect((await row.boundingBox())?.height).toBe(42);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('checkbox', { name: 'Use compact file list' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await row.boundingBox())?.height).toBe(34);
  });
});
