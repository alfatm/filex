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

  test('Security names the sign-in method and changes the password on its own', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    // The realm comes from the server, and it is what decides whether a password form is offered at all.
    await expect(dialog.getByText('Local account · two-factor off')).toBeVisible();

    await dialog.getByRole('button', { name: 'Password Change your password' }).click();
    const current = dialog.getByRole('textbox', { name: 'Current password' });
    await expect(dialog.getByText('Your other sessions will be signed out.')).toBeVisible();

    // Too short is caught before the server is bothered.
    await current.fill('demo');
    await dialog.getByRole('textbox', { name: 'New password', exact: true }).fill('short');
    await dialog.getByRole('textbox', { name: 'Repeat new password' }).fill('short');
    await dialog.getByRole('button', { name: 'Change password' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Use at least 8 characters.');

    // A typo in the repeat never leaves the browser either.
    await dialog.getByRole('textbox', { name: 'New password', exact: true }).fill('longenough1');
    await dialog.getByRole('textbox', { name: 'Repeat new password' }).fill('longenough2');
    await dialog.getByRole('button', { name: 'Change password' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The two new passwords do not match.');

    // The wrong current password is the server's answer, and it lands on the form rather than in a toast.
    await current.fill('not-it');
    await dialog.getByRole('textbox', { name: 'Repeat new password' }).fill('longenough1');
    await dialog.getByRole('button', { name: 'Change password' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('That is not your current password.');

    // The change does not wait for "Save changes": it is not part of the draft that Cancel throws away.
    await current.fill('demo');
    await dialog.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Password changed')).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Current password' })).toBeHidden();
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

  test('the display name is saved to the account and shows up wherever the avatar does', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    const displayName = dialog.getByRole('textbox', { name: 'Display name' });
    await expect(displayName).toHaveValue('demo');
    await displayName.fill('Ada Lovelace');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();

    // The account, not the form: the header avatar re-initialises from the name the repository returned.
    await expect(page.getByRole('button', { name: 'Account' })).toContainText('A');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Display name' })).toHaveValue('Ada Lovelace');
  });

  test('the remove-photo button is inert until there is a photo to remove', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Remove' })).toBeDisabled();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Change photo' })).toBeEnabled();
  });
});
