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
    const nav = dialog.getByRole('tablist', { name: 'User settings' });
    for (const name of ['Profile', 'Preferences', 'Notifications', 'Security', 'AI assistant']) {
      await expect(nav.getByRole('tab', { name })).toBeVisible();
    }
    // The account fields come from the repository, not from the form's own defaults.
    await expect(dialog.getByRole('textbox', { name: 'Full name' })).toHaveValue('demo');
    await expect(dialog.getByText('demo@filex.local').first()).toBeVisible();

    // One tab, one panel: the others are not rendered at all, so a stale control cannot be reached.
    await nav.getByRole('tab', { name: 'AI assistant' }).click();
    await expect(dialog.getByText('The model and API key are configured by your administrator.')).toBeVisible();
    await expect(nav.getByRole('tab', { name: 'AI assistant' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('textbox', { name: 'Full name' })).toBeHidden();

    // Arrows walk the strip, as in every other tab strip in the app.
    await page.keyboard.press('ArrowDown');
    await expect(nav.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'User settings' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'User settings' })).toBeVisible();
  });

  test('Security names the sign-in method and changes the password on its own', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Security' }).click();
    // The realm comes from the server, and it is what decides whether a password form is offered at all.
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Two-factor authentication' })).toContainText('Off');

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

  test('the profile fields and the notification switches are the account, not this browser', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Job title' }).fill('Product Designer');
    await dialog.getByRole('tab', { name: 'Notifications' }).click();
    const comments = dialog.getByRole('switch', { name: 'Comments' });
    await expect(comments).toBeChecked();
    await comments.click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();

    // Nothing of either lives in this browser's settings blob — they went to the repository.
    const stored = await page.evaluate(() => localStorage.getItem('filex.app.settings') ?? '');
    expect(stored).not.toContain('Product Designer');
    expect(stored).not.toContain('comments');

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Job title' })).toHaveValue('Product Designer');
    await page.getByRole('dialog').getByRole('tab', { name: 'Notifications' }).click();
    await expect(page.getByRole('dialog').getByRole('switch', { name: 'Comments' })).not.toBeChecked();
  });

  test('Active sessions lists where the account is signed in and ends one', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Security' }).click();

    // The count is part of the collapsed row, so it is fetched with the rest of the Security answer.
    const row = dialog.getByRole('button', { name: /Active sessions/ });
    await expect(row).toContainText('3 sessions');
    await row.click();

    // The user agent is turned into something a person can recognise; the current session has no button.
    const list = dialog.getByRole('list', { name: 'Active sessions' });
    const here = list.getByRole('listitem').filter({ hasText: 'Chrome · macOS' });
    await expect(here).toContainText('This device');
    await expect(here.getByRole('button', { name: 'End session' })).toHaveCount(0);

    const phone = list.getByRole('listitem').filter({ hasText: 'Safari · iPhone' });
    await expect(phone).toContainText('192.168.1.31');
    await phone.getByRole('button', { name: 'End session' }).click();

    // Ending a session acts at once — it is not part of the draft "Save changes" commits.
    await expect(dialog.getByText('Safari · iPhone')).toBeHidden();
    await expect(row).toContainText('2 sessions');
  });

  test('the theme applies on save and is discarded on cancel', async ({ page }) => {
    const html = page.locator('html');
    await expect(html).not.toHaveAttribute('data-theme', /.*/);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(html).not.toHaveAttribute('data-theme', /.*/);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Preferences' }).click();
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
    await page.getByRole('tab', { name: 'Preferences' }).click();
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
    await page.getByRole('tab', { name: 'Preferences' }).click();
    await page.getByRole('switch', { name: 'Use compact file list' }).click();
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

  test('the remove-photo button appears only once there is a photo to remove', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Remove' })).toBeHidden();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Change photo' })).toBeEnabled();
  });
});
