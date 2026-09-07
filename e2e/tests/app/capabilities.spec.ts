import { test, expect } from '@playwright/test';

/**
 * The capability snapshot (`GET /api/capabilities`) decides what the UI offers. `?caps=` overrides it, which is how
 * these tests stand in for an older or narrower server.
 */
test.describe('Capabilities', () => {
  test('a server without the assistant hides its trigger', async ({ page }) => {
    await page.goto('files');
    await expect(page.getByRole('button', { name: 'AI assistant' })).toBeVisible();

    await page.goto('files?caps=assistant:0');
    await expect(page.getByRole('button', { name: 'AI assistant' })).toHaveCount(0);
  });

  test('actions the server cannot serve stay in the menu and say why', async ({ page }) => {
    await page.goto('files?caps=move:0');
    await page.getByRole('option', { name: /^README\.md/ }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'More' });
    // "Move to trash" also contains "Move to".
    for (const name of ['Move to', 'Cut']) {
      const item = menu.getByRole('menuitem', { name, exact: true });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toHaveAttribute('title', 'Not available on this server');
    }
    // Everything else still works.
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Move to trash' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('features the mock does implement are offered', async ({ page }) => {
    await page.goto('files?caps=tags:1,versions:1,permissions:1');
    await page.getByRole('option', { name: /^README\.md/ }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'More' });
    for (const name of ['Tags', 'Version history', 'Manage access']) {
      await expect(menu.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled', 'true');
    }
  });

  test('a user who may not delete forever sees the trash button inert', async ({ page }) => {
    await page.goto('trash?demo=trash&caps=deleteForever:0');
    const empty = page.getByRole('button', { name: 'Empty trash' });
    await expect(empty).toBeDisabled();
    await expect(empty).toHaveAttribute('title', 'Not available on this server');

    await page.goto('trash?demo=trash');
    await expect(page.getByRole('button', { name: 'Empty trash' })).toBeEnabled();
  });
});
