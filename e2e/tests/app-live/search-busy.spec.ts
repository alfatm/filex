import { test, expect } from '@playwright/test';

/**
 * §6.3 / §21 of the audit: with the search request artificially slowed to 2.5 s the page showed nothing at all —
 * no spinner, no `aria-busy`, no line of text. There was no way to tell a slow search from a finished one.
 *
 * The delay is injected here the same way the audit injected it: the answer is held back, and what the page says
 * while it waits is the whole question.
 */

const DELAY_MS = 2_500;

test('a slow search says it is still searching', async ({ page }) => {
  await page.route('**/api/files/search**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    await route.continue();
  });

  await page.goto('search?q=anything');

  // Both halves of the answer: the line a person reads, and the flag a screen reader is told. The toast host is
  // a `role="status"` of its own and is always in the page, so the line is looked for inside `main`.
  const busy = page.locator('main [aria-busy="true"]');
  const saying = page.locator('main').getByRole('status');
  await expect(saying).toContainText('Searching');
  await expect(busy).toHaveCount(1);

  // And it goes away once the answer is in — a busy flag that never clears is worse than none.
  await expect(saying).toHaveCount(0, { timeout: 15_000 });
  await expect(busy).toHaveCount(0);
});
