import { test, expect, type Locator, type Page } from '@playwright/test';
import { countIn } from '../../helpers/mockTree';

/**
 * Pixel baselines for the reference states of app/docs/DESIGN-SPEC.md (§2–§6) and the secondary surfaces (§7),
 * reached through the screenshot-only query hooks (`?select=`, `?view=`, `?panel=`, `?modal=`, `?menu=`,
 * `?demo=`). Baselines live in `__screenshots__/` next to this file (no platform suffix — see
 * `snapshotPathTemplate` in playwright.app.config.ts). Refresh them with `pnpm test:app:update` after a
 * deliberate design change, and look at the diff before committing.
 *
 * The page clock is pinned: the shared-with-me nodes are dated relative to "now" (Recent's "Today" group).
 *
 * ⚠ ONE BASELINE SET, ONE ENVIRONMENT — and this file refuses to run outside it.
 *
 * The fifteen PNGs are 3.7 MB and carry no platform or browser suffix, which is a deliberate choice and not an
 * oversight. The alternative — `{arg}-{platform}-{browser version}{ext}` — sounds tidier and is worse here: every
 * Playwright bump would add a fresh 3.7 MB set beside the one it replaces, every contributor's OS a further one,
 * and this repository keeps all of it forever. So there is exactly one set, taken in the environment named below,
 * and `beforeAll` fails the whole file anywhere else rather than reporting fifteen mismatches whose real cause is
 * the machine — or, on `--update-snapshots`, quietly overwriting good baselines with that machine's rendering.
 *
 * Both halves matter. The OS decides how glyphs and scrollbars are rasterised (Inter is self-hosted, so the font
 * FILE is the same everywhere, its rendering is not); the Chromium build decides everything else, and it follows
 * `@playwright/test` — pinned to one exact version in `e2e/package.json` and `app/package.json` precisely so this
 * check can name a single build. Bump that version and this check fails on purpose: retake the baselines in the
 * new browser, in one commit, with the diff looked at.
 */
const FIXED_TIME = '2026-07-10T16:00:00Z';

/**
 * Where the committed baselines were taken. The reference environment is the Playwright image of the pinned
 * version — `mcr.microsoft.com/playwright:v1.62.1-noble` — and any Linux host running the Chromium that the
 * pinned `@playwright/test` downloads renders identically to it.
 */
const BASELINE_PLATFORM = 'linux';
const BASELINE_CHROMIUM = '151.0.7922.34';

test.beforeAll(async ({ browser }) => {
  const version = browser.version();
  if (process.platform === BASELINE_PLATFORM && version === BASELINE_CHROMIUM) return;
  throw new Error(
    `the visual baselines in tests/app/__screenshots__/ were taken on ${BASELINE_PLATFORM} with Chromium ` +
      `${BASELINE_CHROMIUM}, and this is ${process.platform} with Chromium ${version}.\n\n` +
      `There is one baseline set on purpose (see the note at the top of this file), so comparing here would ` +
      `report the machine as a design change, and refreshing here would overwrite good baselines with this ` +
      `machine's rendering. Either:\n` +
      `  • run this file in the reference image:\n` +
      `      docker run --rm -it -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-noble \\\n` +
      `        pnpm --filter filex-e2e test:app\n` +
      `  • or run the rest of the app suite and leave this file out:\n` +
      `      pnpm --filter filex-e2e test:app --grep-invert "reference state:"\n\n` +
      `If the Chromium build moved because @playwright/test was bumped, that is the moment to retake all ` +
      `fifteen baselines and update BASELINE_CHROMIUM in one commit.`,
  );
});

const STATES: { name: string; route: string; ready: string | ((page: Page) => Locator) }[] = [
  { name: 'files-grid-details', route: 'files?select=Design&panel=details', ready: `Folder • ${countIn('Design')} items` },
  { name: 'files-list', route: 'files?view=list&select=Design&panel=none', ready: 'Last modified' },
  // The result count is the screenshot's business, not the gate's: waiting on the sentence rather than its number
  // keeps a regenerated tree out of the readiness check, and the baseline still shows what the number was.
  {
    name: 'search-advanced',
    route: 'files?view=list&select=Design&panel=none&modal=search',
    ready: (page) => page.getByText(/^\d+ matching items$/),
  },
  {
    name: 'assistant',
    route: 'files?view=list&select=Design&panel=assistant&demo=assistant',
    ready: (page) => page.getByText(/^I found \d+ matching files based on filename and content\.$/),
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
