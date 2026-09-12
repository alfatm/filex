import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * §7.3 of the audit carries no verdict: the bundled Chromium has no proprietary codecs, so nobody could tell a
 * player that is wired wrong from an H.264 stream the browser simply refuses to decode.
 *
 * The two are separable, and this spec separates them. Everything up to the decoder — the element, its source, the
 * controls, and a server that answers a RANGE request, which is what seeking needs — is asserted. Whether the
 * frames actually appear is REPORTED rather than asserted, because in this browser the answer says nothing about
 * the product. A real Chrome or Firefox is still the only place that question gets a real answer.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Video E2E';
const NAME = 'sample.mp4';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'file-types', NAME);

test.describe.configure({ mode: 'serial' });

async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  await expect(page.getByRole('radio', { name: 'Grid view' })).toBeVisible();
}

async function newFolder(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();
}

test('the fixture: a real video file on the drive', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await newFolder(page, FOLDER);
  await open(page, FOLDER);
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles([{ name: NAME, mimeType: 'video/mp4', buffer: fs.readFileSync(FIXTURE) }]);
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 90_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
});

test('the preview mounts a real player pointed at the file', async ({ page }) => {
  await open(page, FOLDER);
  await page.getByRole('option').filter({ has: page.getByText(NAME, { exact: true }) }).dblclick();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const video = dialog.locator('video');
  await expect(video, 'a <video> element, not the "no preview" card').toHaveCount(1);
  await expect(video).toHaveAttribute('controls', '');
  const src = await video.getAttribute('src');
  expect(src, 'the player points at this file on the server').toContain(encodeURIComponent(NAME));

  // Seeking is a range request. A server that answers 200 with the whole file makes the scrubber useless on
  // anything large, and that is a product defect the decoder has nothing to do with.
  const ranged = await page.request.get(src as string, { headers: { Range: 'bytes=0-1023' } });
  expect(ranged.status(), 'the server serves byte ranges').toBe(206);
  expect((await ranged.body()).length).toBe(1024);

  const decoded = await video.evaluate((el: HTMLVideoElement) => ({ w: el.videoWidth, code: el.error?.code ?? 0 }));
  console.log(
    `[video] this browser ${decoded.w > 0 ? `decoded the stream (${decoded.w}px wide)` : `did NOT decode it (MediaError ${decoded.code})`}` +
      ' — Playwright Chromium ships without proprietary codecs, so only a real Chrome/Firefox answers §7.3.',
  );
});
