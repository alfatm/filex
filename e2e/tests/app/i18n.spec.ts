import { test, expect } from '@playwright/test';

/**
 * The switcher lives in Settings → Preferences → Language, and `setLocale`
 * persists the choice to `localStorage['filex.app.locale']` (en | ru | tr);
 * `app/src/i18n/index.ts` reads that key on start and falls back to
 * `navigator.language`. What is under test here is the locale the FIRST render
 * picks up — which is what a reload after switching gives — so the tests seed
 * the key the switcher writes instead of driving the modal.
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
