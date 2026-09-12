import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dropping a dragged node on a folder moves it — the listing's own drop target, against a real server.
 *
 * ⚠ The IMAGE card is the interesting one. A card whose thumbnail is a real `<img>` used to hand the drag to
 * Chrome's own image drag: the picture became the drag image, `Files` appeared among the transfer's types, and the
 * drop effect turned to `copy` against an `effectAllowed` of `move` — a no-drop cursor over a folder that was
 * lit up as a valid target.
 */
const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'DnD E2E';
const TARGET = 'Target';
const FILE = 'dragged.txt';
const IMAGE = 'dnd-thumb.png';

/** A real picture: the server has to produce a thumbnail for it, which is what puts an `<img>` in the card. */
const PNG = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/dnd-thumb.png');

test.describe.configure({ mode: 'serial' });

function row(page: Page, name: string) {
  return page.getByRole('grid').locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) });
}

function card(page: Page, name: string) {
  return page.locator('[role="option"]').filter({ has: page.getByText(name, { exact: true }) });
}

async function openFolder(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
}

async function setView(page: Page, name: 'List view' | 'Grid view') {
  const control = page.getByRole('radio', { name });
  await expect(control).toBeVisible();
  if ((await control.getAttribute('aria-checked')) !== 'true') await control.click();
  await expect(control).toHaveAttribute('aria-checked', 'true');
}

async function create(page: Page, entry: string, name: string, field: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: entry, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: field }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
}

/** A real pointer drag, which is what makes Chrome start (or hijack) the HTML5 drag the app listens for. */
async function dragOnto(page: Page, source: { x: number; y: number }, target: { x: number; y: number }) {
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.move(target.x, target.y + 1, { steps: 4 });
  await page.mouse.up();
}

function centre(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('fixture: a folder holding a target folder, a text file and an image', async ({ page }) => {
  await openFolder(page);
  await setView(page, 'List view');
  await create(page, 'Folder', FOLDER, 'New folder');
  await openFolder(page, FOLDER);
  await create(page, 'Folder', TARGET, 'New folder');
  await create(page, 'File', FILE, 'New file');
  await page.setInputFiles('input[type=file]', PNG);
  await expect(row(page, TARGET)).toBeVisible();
  await expect(row(page, FILE)).toBeVisible();
  await expect(row(page, IMAGE)).toBeVisible();
});

test('a table row drops on a folder row', async ({ page }) => {
  await openFolder(page, FOLDER);
  await setView(page, 'List view');
  await expect(row(page, FILE)).toBeVisible();
  await dragOnto(page, centre((await row(page, FILE).boundingBox())!), centre((await row(page, TARGET).boundingBox())!));

  await expect(row(page, FILE)).toHaveCount(0);
  await page.reload();
  await setView(page, 'List view');
  await expect(row(page, FILE)).toHaveCount(0);
});

/**
 * The regression: the grab lands on the card's thumbnail, which is where a person grabs a picture, and the
 * transfer must stay the app's own — a `move` the folder accepts, not Chrome's image drag.
 */
test('an image card drops on a folder card', async ({ page }) => {
  await openFolder(page, FOLDER);
  await setView(page, 'Grid view');
  const source = card(page, IMAGE);
  await expect(source).toBeVisible();
  // The `<img>` is the whole point of this test: without it the grab lands on a placeholder tile and Chrome has
  // no image drag to hijack, so the regression cannot show.
  await expect(source.locator('img')).toBeVisible({ timeout: 15_000 });
  // The thumbnail, not the card: the top 108 px of the 166 px card is where the `<img>` is.
  const box = (await source.boundingBox())!;

  // What the transfer looks like over the folder, which is what the no-drop cursor was about. A hijacked image
  // drag shows up as the browser's own `text/uri-list`/`text/html` beside ours, and as a drop effect that no
  // longer matches `effectAllowed`.
  const seen: string[] = [];
  await page.exposeFunction('recordDragOver', (state: string) => seen.push(state));
  await page.evaluate(() => {
    document.addEventListener('dragover', (event) => {
      const transfer = (event as DragEvent).dataTransfer;
      const record = (window as unknown as { recordDragOver: (state: string) => void }).recordDragOver;
      record(`${transfer?.effectAllowed}/${transfer?.dropEffect}/${[...(transfer?.types ?? [])].join(',')}`);
    });
  });

  await dragOnto(page, { x: box.x + box.width / 2, y: box.y + 40 }, centre((await card(page, TARGET).boundingBox())!));
  expect([...new Set(seen)]).toEqual(['move/move/text/plain']);

  await expect(card(page, IMAGE)).toHaveCount(0);
  await page.reload();
  await setView(page, 'Grid view');
  await expect(card(page, IMAGE)).toHaveCount(0);
  await openFolder(page, FOLDER, TARGET);
  await setView(page, 'Grid view');
  await expect(card(page, IMAGE)).toBeVisible();
});
