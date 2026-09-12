import { test, expect, type Page } from '@playwright/test';

/**
 * The stand itself, measured at every width before anything measures the layout.
 *
 * What it proves is the part that is new: the drive was NOT written by this suite. The runner copied the
 * demo-assets tree next to the server and registered a storage over it; everything below is there because
 * `internal/sync` walked the directory and catalogued it. If that walk did not happen — or the run went on before
 * it finished — these fail here, with a message about the fixture, instead of failing later as "the app is broken".
 *
 * ⚠ Anchors, never counts. The assets live in their own repository and gain files without asking this one, so a
 * folder is asserted to EXIST and to be non-empty; asserting "144 files" would paint the suite red on somebody
 * else's commit.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
/** Folders the demo set has always had; the suite navigates to them by name. */
const ANCHORS = ['Documents', 'Photos', 'Design', 'Code'];

async function openDrive(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  await expect(page.getByRole('main')).toBeVisible();
}

test('the server catalogued the demo tree by itself', async ({ page }) => {
  await openDrive(page);
  for (const folder of ANCHORS) {
    await expect(page.getByText(folder, { exact: true }).first(), `${folder} is missing from ${DRIVE}`).toBeVisible();
  }
});

test('a folder from the fixture has content', async ({ page }) => {
  await openDrive(page, 'Documents');
  // Either view will do — the point is that the walk reached one level down, not which control is drawn.
  const entries = page.getByRole('option').or(page.getByRole('grid').locator('tbody tr'));
  await expect(entries.first()).toBeVisible();
});

test('the page does not scroll sideways', async ({ page }) => {
  await openDrive(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the page scrolls horizontally').toBeLessThanOrEqual(0);
});
