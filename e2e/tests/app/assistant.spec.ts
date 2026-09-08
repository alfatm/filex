import { test, expect, type Page } from '@playwright/test';

function trigger(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: 'AI assistant' });
}

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'AI assistant' });
}

test.describe('AI assistant', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('files');
    await trigger(page).click();
    // The panel is a lazily loaded chunk; its key handling starts once it is mounted.
    await expect(panel(page)).toBeVisible();
  });

  test('chats: a new one appears in the list, gets renamed, and can be dropped', async ({ page }) => {
    const chat = panel(page);
    await chat.getByRole('button', { name: 'New chat' }).click();
    await chat.getByRole('button', { name: 'Chats' }).click();

    const rows = chat.getByRole('list', { name: 'Chats' }).getByRole('listitem');
    await expect(rows).toHaveCount(1);
    // A conversation the title generator has not named yet still has to be callable something.
    await expect(rows.first()).toContainText('Untitled chat');
    await expect(chat.getByText('1 of 100 chats')).toBeVisible();

    await rows.first().getByRole('button', { name: /^Rename/ }).click();
    const name = chat.getByRole('textbox', { name: 'Chat name' });
    await name.fill('Q3 contracts');
    await name.press('Enter');
    await expect(rows.first()).toContainText('Q3 contracts');

    // The search filters what is already loaded — the history is capped, so there is nothing to fetch.
    const search = chat.getByRole('textbox', { name: 'Search chats' });
    await search.fill('nothing like this');
    await expect(chat.getByText('No chat matches that')).toBeVisible();
    await search.fill('q3');
    await expect(rows).toHaveCount(1);

    await rows.first().getByRole('button', { name: /^Delete/ }).click();
    await expect(chat.getByText('No chats yet')).toBeVisible();
  });

  test('opens from the Sparkles button', async ({ page }) => {
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: 'AI assistant' })).toBeVisible();
    await expect(panel(page).getByText('Online')).toBeVisible();
    // The panel's own X closes it, so the topbar trigger is hidden while it is open.
    await expect(trigger(page)).toBeHidden();
    await expect(panel(page).getByRole('radio', { name: 'Filename' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a suggestion sends a prompt and the answer streams in with result cards', async ({ page }) => {
    const suggestion = panel(page).getByRole('button', { name: 'Search by tag: design' });
    await suggestion.click();

    await expect(panel(page).getByText('Search by tag: design').last()).toBeVisible();
    // Sending is locked while the turn streams (the textarea stays editable), then released.
    await expect(suggestion).toBeDisabled();
    const card = panel(page).locator('article').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(panel(page).getByRole('log').getByText(/^I found \d+ matching files?\.$/)).toBeVisible();
    await expect(suggestion).toBeEnabled({ timeout: 10_000 });
    await expect(panel(page).getByRole('textbox', { name: 'Ask to find files…' })).toBeEnabled();
    await expect(card).toContainText('/demo');
  });

  test('opens alongside the details panel instead of replacing it', async ({ page }) => {
    const details = page.getByRole('complementary', { name: 'Details' });
    await expect(details).toBeVisible();
    await expect(panel(page)).toBeVisible();
    // Each panel closes on its own; the other stays.
    await details.getByRole('button', { name: 'Close' }).click();
    await expect(details).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(details).toBeVisible();
    await expect(panel(page)).toBeVisible();
  });

  test('mode chips switch', async ({ page }) => {
    const modes = panel(page).getByRole('radiogroup', { name: 'Search mode' });
    await expect(modes.getByRole('radio')).toHaveCount(3);
    await modes.getByRole('radio', { name: 'Content' }).click();
    await expect(modes.getByRole('radio', { name: 'Content' })).toHaveAttribute('aria-checked', 'true');
    await expect(modes.getByRole('radio', { name: 'Filename' })).toHaveAttribute('aria-checked', 'false');
    await modes.getByRole('radio', { name: 'Tags' }).click();
    await expect(modes.getByRole('radio', { name: 'Tags' })).toHaveAttribute('aria-checked', 'true');
    await expect(modes.getByRole('radio', { name: 'Content' })).toHaveAttribute('aria-checked', 'false');
  });

  test('Esc and the close button close the panel and bring the trigger back', async ({ page }) => {
    // Esc works from anywhere in the window; focus then lands on the search box since the trigger was hidden.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(trigger(page)).toBeVisible();
    await expect(page.getByRole('banner').getByRole('searchbox')).toBeFocused();

    await trigger(page).click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(trigger(page)).toBeVisible();
  });
});
