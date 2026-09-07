import { test, expect } from '@playwright/test';

/**
 * The app has no language switcher in its UI yet. `app/src/i18n/index.ts` reads
 * the locale from `localStorage['filex.app.locale']` (en | ru | tr) and falls
 * back to `navigator.language`, so the locale is set through storage before
 * the first navigation — the same thing a switcher would persist.
 */
const LOCALE_KEY = 'filex.app.locale';

const CASES = [
  { locale: 'ru', files: 'Мои файлы', lang: 'ru' },
  { locale: 'tr', files: 'Dosyalarım', lang: 'tr' },
] as const;

test.describe('i18n', () => {
  test('defaults to English from the browser language', async ({ page }) => {
    await page.goto('files');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'My files', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  for (const { locale, files, lang } of CASES) {
    test(`stored locale "${locale}" renders the sidebar in that language`, async ({ page }) => {
      await page.addInitScript(
        ([key, value]) => {
          localStorage.setItem(key, value);
        },
        [LOCALE_KEY, locale] as const,
      );
      await page.goto('files');
      const nav = page.getByRole('navigation');
      await expect(nav.getByRole('link', { name: files, exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'My files', exact: true })).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
    });
  }
});
