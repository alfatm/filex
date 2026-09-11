import { test, expect, type Page } from '@playwright/test';

/**
 * The preview modal against real files.
 *
 * §7.4 of the audit: a correct `.wav` drew the generic "No preview available" card with no `<audio>` anywhere.
 * §7.1: images had no zoom control and the walk through a listing reported `Next` as disabled in the middle of it.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Preview E2E';
const SOUND = 'tone.wav';
const IMAGE = 'dot.png';
/** Enough files that Previous and Next both have somewhere to go from the middle. */
const TEXTS = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];

test.describe.configure({ mode: 'serial' });

/** A 0.05 s silent 8-bit mono WAV: a real RIFF header, so the browser decodes it rather than refusing it. */
function wav(): Buffer {
  const rate = 8000;
  const samples = rate / 20;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function card(page: Page, name: string) {
  return page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
}

async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const grid = page.getByRole('radio', { name: 'Grid view' });
  await expect(grid).toBeVisible();
  if ((await grid.getAttribute('aria-checked')) !== 'true') await grid.click();
}

async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles(files);
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 60_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
}

/** Opens the preview of a file by double-clicking its card. */
async function preview(page: Page, name: string) {
  await card(page, name).dblclick();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(name, { exact: true }).first()).toBeVisible();
  return dialog;
}

test('the fixture: a sound file, an image and four text files', async ({ page }) => {
  await open(page);
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(card(page, FOLDER)).toBeVisible();

  await open(page, FOLDER);
  await upload(page, [
    { name: SOUND, mimeType: 'audio/wav', buffer: wav() },
    { name: IMAGE, mimeType: 'image/png', buffer: PNG },
    ...TEXTS.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} body\n`) })),
  ]);
  await page.reload();
  await expect(card(page, SOUND)).toBeVisible();
});

test('a sound file gets a player, not the "no preview" card', async ({ page }) => {
  await open(page, FOLDER);
  const dialog = await preview(page, SOUND);

  const player = dialog.locator('audio');
  await expect(player).toHaveCount(1);
  await expect(dialog.getByText('No preview available')).toHaveCount(0);

  // The player has to have read the file: a duration means the bytes decoded, not merely that a tag was rendered.
  await expect
    .poll(async () => player.evaluate((el: HTMLAudioElement) => (Number.isFinite(el.duration) ? el.duration : 0)), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  // And nothing starts playing by itself.
  expect(await player.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);

  // Two of them on the audio card: the header icon and the button under the player. Either one is the point.
  await expect(dialog.getByRole('link', { name: 'Download' }).first()).toBeVisible();
});

test('an image preview has zoom controls and a Download', async ({ page }) => {
  await open(page, FOLDER);
  const dialog = await preview(page, IMAGE);

  // Two of them on the audio card: the header icon and the button under the player. Either one is the point.
  await expect(dialog.getByRole('link', { name: 'Download' }).first()).toBeVisible();
  const zoomIn = dialog.getByRole('button', { name: 'Zoom in' });
  await expect(zoomIn).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Zoom out' })).toBeVisible();

  await expect(dialog.getByText('100%')).toBeVisible();
  await zoomIn.click();
  await expect(dialog.getByText('125%')).toBeVisible();
  await dialog.getByRole('button', { name: 'Fit to screen' }).click();
  await expect(dialog.getByText('100%')).toBeVisible();
});

test('Next and Previous walk the whole listing', async ({ page }) => {
  await open(page, FOLDER);
  // Six files in the folder, and the listing's order is the server's — so the starting position is read off the
  // counter rather than assumed.
  const dialog = await preview(page, TEXTS[1]);
  const counter = dialog.getByText(/\d+ of 6/);
  const at = async () => Number((await counter.innerText()).match(/(\d+) of 6/)![1]);

  const next = dialog.getByRole('button', { name: 'Next file' });
  const previous = dialog.getByRole('button', { name: 'Previous file' });
  const start = await at();
  expect(start, 'the fixture needs a file with neighbours on both sides').toBeGreaterThan(1);
  expect(start).toBeLessThan(6);
  await expect(next, 'Next is disabled in the middle of the list').toBeEnabled();
  await expect(previous).toBeEnabled();

  // One press at a time to the end: the counter moves every time, and only the last file may disable Next.
  for (let expected = start + 1; expected <= 6; expected++) {
    await next.click();
    await expect(counter).toHaveText(new RegExp(`${expected} of 6`));
    await expect(next).toBeEnabled({ enabled: expected < 6 });
  }
  await previous.click();
  await expect(next).toBeEnabled();
  // And back to the front the same way.
  for (let expected = 4; expected >= 1; expected--) {
    await previous.click();
    await expect(counter).toHaveText(new RegExp(`${expected} of 6`));
  }
  await expect(previous).toBeDisabled();
});
