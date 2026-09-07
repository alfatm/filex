import { test, expect } from '@playwright/test';

/** Tags are edited in their own modal and searched with `tag:` — the two ends of the same feature. */
test.describe('Tags', () => {
  test('the modal adds and removes tags, and search finds what it wrote', async ({ page }) => {
    await page.goto('files');
    await page.getByRole('option', { name: /^README\.md/ }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Tags' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('No tags yet')).toBeVisible();
    const input = dialog.getByRole('textbox', { name: 'Tags' });
    await input.fill('handbook');
    await input.press('Enter');
    await input.fill('onboarding');
    await input.press('Enter');
    // A duplicate adds nothing.
    await input.fill('handbook');
    await input.press('Enter');
    const chips = dialog.getByRole('list', { name: 'Tags' }).getByRole('listitem');
    await expect(chips).toHaveText(['handbook', 'onboarding']);

    await dialog.getByRole('button', { name: 'Remove tag onboarding' }).click();
    await expect(chips).toHaveText(['handbook']);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Tags of “README.md” saved')).toBeVisible();

    // Reopening shows what was saved.
    await page.getByRole('option', { name: /^README\.md/ }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Tags' }).click();
    await expect(page.getByRole('dialog').getByRole('list', { name: 'Tags' }).getByRole('listitem')).toHaveText(['handbook']);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // Searching happens in the same page load: the mock repository lives in the tab, and a reload would forget the tag.
    await page.getByRole('banner').getByRole('button', { name: 'Advanced search' }).click();
    const search = page.getByRole('dialog');
    const tagField = search.getByRole('textbox', { name: 'Tags' });
    await tagField.fill('handbook');
    await tagField.press('Enter');
    await search.getByText('All storages').click();
    await search.getByRole('button', { name: 'Search', exact: true }).click();

    const rows = page.getByRole('main').getByRole('table').locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('README.md');
  });

  test('a tag left in the box counts as typed', async ({ page }) => {
    await page.goto('files');
    await page.getByRole('option', { name: /^app\.ts/ }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Tags' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Tags' }).fill('draft');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Tags of “app.ts” saved')).toBeVisible();
  });
});
