import { test, expect } from '@playwright/test';

async function openItemMenu(page: import('@playwright/test').Page, name: RegExp, entry: string) {
  await page.getByRole('option', { name }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: entry }).click();
}

test.describe('Version history', () => {
  test('lists the revisions of a file and restores an older one', async ({ page }) => {
    await page.goto('files');
    await openItemMenu(page, /^README\.md/, 'Version history');

    const dialog = page.getByRole('dialog');
    const rows = dialog.getByRole('list', { name: 'Version history' }).getByRole('listitem');
    // Every row is content the file USED to hold — the live bytes have no row — so every row can be restored.
    await expect(rows).toHaveCount(3);
    await expect(dialog.getByRole('button', { name: 'Restore' })).toHaveCount(3);

    const older = rows.nth(2);
    const label = (await older.textContent())!;
    await older.getByRole('button', { name: 'Restore' }).click();
    // Restoring snapshots the live bytes first, so the list grows by one and nothing in between is dropped.
    await expect(rows).toHaveCount(4);
    await expect(dialog.getByRole('button', { name: 'Restore' })).toHaveCount(4);
    await expect(page.getByText('Restored the revision from')).toBeVisible();
    expect(label).toBeTruthy();
  });

  test('a folder says it keeps no revisions', async ({ page }) => {
    await page.goto('files');
    await openItemMenu(page, /^Design\b/, 'Version history');
    await expect(page.getByRole('dialog').getByText('A folder keeps no revisions')).toBeVisible();
  });
});

test.describe('Manage access', () => {
  test('invites someone, changes their role and takes it away again', async ({ page }) => {
    await page.goto('files');
    await openItemMenu(page, /^README\.md/, 'Manage access');

    const dialog = page.getByRole('dialog');
    const people = dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem');
    await expect(people).toHaveCount(1);
    await expect(people.first()).toContainText('You');

    const invite = dialog.getByRole('button', { name: 'Invite' });
    await expect(invite).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Email address' }).fill('nina@example.com');
    await expect(invite).toBeEnabled();
    await invite.click();

    await expect(people).toHaveCount(2);
    await expect(people.nth(1)).toContainText('nina@example.com');
    const role = dialog.getByRole('combobox', { name: /^Role of/ });
    await expect(role).toHaveValue('viewer');
    await role.selectOption('editor');
    await expect(dialog.getByRole('combobox', { name: /^Role of/ })).toHaveValue('editor');

    await dialog.getByRole('button', { name: /^Remove nina/ }).click();
    await expect(people).toHaveCount(1);
  });

  test('the owner row cannot be changed or removed', async ({ page }) => {
    await page.goto('files');
    await openItemMenu(page, /^app\.ts/, 'Manage access');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem').first()).toContainText('Owner');
    await expect(dialog.getByRole('combobox', { name: /^Role of/ })).toHaveCount(0);
  });
});

test.describe('Activity', () => {
  test('the tab reports what just happened to the node', async ({ page }) => {
    await page.goto('files');
    const panel = page.getByRole('complementary', { name: 'Details' });
    await page.getByRole('option', { name: /^README\.md/ }).click();
    await panel.getByRole('tab', { name: 'Activity' }).click();
    const events = panel.getByRole('list', { name: 'Activity' }).getByRole('listitem');
    await expect(events).toHaveCount(2);
    await expect(events.nth(0)).toContainText('You changed the contents');
    await expect(events.nth(1)).toContainText('You created it');

    // A real action lands at the top of the feed.
    await page.getByRole('option', { name: /^README\.md/ }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Add to starred' }).click();
    await expect(events.first()).toContainText('You starred it');

    await page.getByRole('option', { name: /^README\.md/ }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('HANDBOOK.md');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(events.first()).toContainText('You renamed it from “README.md”');
  });
});
