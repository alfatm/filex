import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * Pixel baselines for the reference states of app/docs/DESIGN-SPEC.md (§2–§6) and the secondary surfaces (§7),
 * reached through the screenshot-only query hooks (`?select=`, `?view=`, `?panel=`, `?modal=`, `?menu=`,
 * `?demo=`). Baselines live in `__screenshots__/` next to this file (no platform suffix — see
 * `snapshotPathTemplate` in playwright.app.config.ts). Refresh them with `pnpm test:app:update` after a
 * deliberate design change, and look at the diff before committing.
 *
 * The page clock is pinned: the shared-with-me nodes are dated relative to "now" (Recent's "Today" group).
 */
const FIXED_TIME = '2026-07-10T16:00:00Z';

const STATES: { name: string; route: string; ready: string | ((page: Page) => Locator) }[] = [
  { name: 'files-grid-details', route: 'files?select=Design&panel=details', ready: 'Folder • 8 items' },
  { name: 'files-list', route: 'files?view=list&select=Design&panel=none', ready: 'Last modified' },
  { name: 'search-advanced', route: 'files?view=list&select=Design&panel=none&modal=search', ready: '24 matching items' },
  {
    name: 'assistant',
    route: 'files?view=list&select=Design&panel=assistant&demo=assistant',
    ready: 'I found 3 matching files based on filename and content.',
  },
  { name: 'files-list-menu', route: 'files?view=list&select=Design&panel=none&menu=item', ready: (page) => page.getByRole('menu', { name: 'More' }) },
  {
    name: 'files-list-rename',
    route: 'files?view=list&select=Design&panel=none&modal=rename',
    ready: (page) => page.getByRole('dialog').getByRole('heading', { name: 'Rename' }),
  },
  {
    name: 'preview-image',
    route: 'files?modal=preview&select=mountains.jpg',
    ready: (page) => page.getByRole('dialog', { name: 'mountains.jpg' }).getByRole('img', { name: 'mountains.jpg' }),
  },
  {
    name: 'preview-text',
    route: 'files?modal=preview&select=app.ts',
    ready: (page) => page.getByRole('dialog', { name: 'app.ts' }).locator('pre li').first(),
  },
  { name: 'files-filtered', route: 'files?view=list&filter=type:images&panel=none', ready: 'beach.png' },
  { name: 'settings', route: 'files?modal=settings', ready: 'Manage your profile, preferences, and security.' },
  // The dark palette is the same tokens through `color-scheme`, so one listing is enough to catch a broken pair.
  { name: 'files-list-dark', route: 'files?view=list&select=Design&panel=none&theme=dark', ready: 'Last modified' },
  { name: 'home', route: 'home', ready: 'UI Design.fig' },
  { name: 'recent', route: 'recent', ready: 'Yesterday' },
  { name: 'shared', route: 'shared', ready: 'Marcus Lee' },
  { name: 'trash', route: 'trash?demo=trash', ready: 'Original location' },
];

async function settle(page: Page, ready: string | ((page: Page) => Locator)) {
  await expect(typeof ready === 'string' ? page.getByText(ready) : ready(page)).toBeVisible();
  // Inter is self-hosted (@fontsource); a shot taken before it swaps in differs in every glyph.
  await page.evaluate(() => document.fonts.ready);
  // Thumbnails are real files (demo-assets/) loaded lazily: wait for the images in the frame.
  await page.evaluate(() => {
    const inFrame = (el: Element) => el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight;
    const images = Array.from(document.images)
      .filter((img) => !img.complete && inFrame(img))
      .map(
        (img) =>
          new Promise((resolve) => {
            img.onload = img.onerror = resolve;
          }),
      );
    return Promise.all(images);
  });
}

for (const { name, route, ready } of STATES) {
  test(`reference state: ${name}`, async ({ page }) => {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto(route);
    await settle(page, ready);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
  });
}
