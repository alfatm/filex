import { test, expect, type Page } from '@playwright/test';

/**
 * Uploading onto a name the folder already has. The audit found the second upload stuck in `Waiting` forever: no
 * conflict dialog, no error, no bytes on disk — the row never reached the branch that asks the question.
 *
 * The default `conflictBehavior` is `ask`, so every one of these ends with the person choosing.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Conflict E2E';
const NAME = 'collide.txt';
const FIRST = 'first body\n';
const SECOND = 'second body, longer than the first\n';

test.describe.configure({ mode: 'serial' });

function card(page: Page, name: string) {
  return page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
}

function tray(page: Page) {
  return page.getByRole('region', { name: /^Uploading|upload complete$|upload failed$/ });
}

async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const grid = page.getByRole('radio', { name: 'Grid view' });
  await expect(grid).toBeVisible();
  if ((await grid.getAttribute('aria-checked')) !== 'true') await grid.click();
}

/** New → Upload files with one in-memory file. Returns once the chooser has been answered, not once it landed. */
async function upload(page: Page, body: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles({ name: NAME, mimeType: 'text/plain', buffer: Buffer.from(body) });
}

test('the fixture: a folder with one file in it', async ({ page }) => {
  await open(page);
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(card(page, FOLDER)).toBeVisible();

  await open(page, FOLDER);
  await upload(page, FIRST);
  await expect(tray(page).getByText('1 upload complete')).toBeVisible({ timeout: 30_000 });
  await tray(page).getByRole('button', { name: 'Close' }).click();
  await expect(card(page, NAME)).toBeVisible();
});

test('Skip leaves the file that is already there', async ({ page }) => {
  await open(page, FOLDER);
  await upload(page, SECOND);

  const dialog = page.getByRole('dialog');
  // The question itself — the audit never saw it: the row sat in `Waiting` with nothing to answer.
  await expect(dialog.getByRole('heading', { name: `Replace “${NAME}”?` })).toBeVisible({ timeout: 30_000 });
  // ⚠ `getByText`: the dialog's ✕ carries aria-label="Skip" too, so the role query matches two controls.
  await dialog.getByText('Skip', { exact: true }).click();

  // Skipping is an outcome, and it has to be visible rather than silent.
  await expect(tray(page)).toContainText('Skipped');
  await tray(page).getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await expect(card(page, NAME)).toHaveCount(1);
  const bytes = await page.request.get(`/api/files/manager?q=download&path=${encodeURIComponent(`${DRIVE}://${FOLDER}/${NAME}`)}`);
  expect(bytes.ok(), `could not read the file back: ${bytes.status()}`).toBeTruthy();
  expect(await bytes.text(), 'Skip overwrote the file it was told to leave alone').toBe(FIRST);
});

test('Keep both lands a second file beside the first', async ({ page }) => {
  await open(page, FOLDER);
  await upload(page, SECOND);

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Replace “${NAME}”?` })).toBeVisible({ timeout: 30_000 });
  // ⚠ `getByText`: the dialog's ✕ carries aria-label="Skip" too, so the role query matches two controls.
  await dialog.getByText('Keep both', { exact: true }).click();

  await expect(tray(page).getByText('1 upload complete')).toBeVisible({ timeout: 30_000 });
  await tray(page).getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await expect(card(page, NAME)).toHaveCount(1);
  // Whatever the server named it, there are two files now and the original still reads as itself.
  await expect(page.getByRole('option')).toHaveCount(2);
});

test('a second Keep both, when the copy name is taken too, still lands', async ({ page }) => {
  await open(page, FOLDER);
  await upload(page, SECOND);

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Replace “${NAME}”?` })).toBeVisible({ timeout: 30_000 });
  // ⚠ `getByText`: the dialog's ✕ carries aria-label="Skip" too, so the role query matches two controls.
  await dialog.getByText('Keep both', { exact: true }).click();

  await expect(tray(page).getByText('1 upload complete')).toBeVisible({ timeout: 30_000 });
  await tray(page).getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await expect(page.getByRole('option')).toHaveCount(3);
});

test('Replace puts the new bytes under the old name', async ({ page }) => {
  await open(page, FOLDER);
  await upload(page, SECOND);

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Replace “${NAME}”?` })).toBeVisible({ timeout: 30_000 });
  // ⚠ `getByText`: the dialog's ✕ carries aria-label="Skip" too, so the role query matches two controls.
  await dialog.getByText('Replace', { exact: true }).click();

  await expect(tray(page).getByText('1 upload complete')).toBeVisible({ timeout: 30_000 });
  await tray(page).getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await expect(page.getByRole('option')).toHaveCount(3);
  await expect(card(page, NAME)).toContainText(`${SECOND.length} B`);
});


/**
 * A rule other than `ask` must still leave a trace: the settings answer for the person, and the tray says what the
 * answer was. Silence here is what made the original defect look like a lost file.
 */
test('with the rule set to Skip, the upload is skipped visibly and without a question', async ({ page }) => {
  await open(page, FOLDER);
  await page.evaluate(() => {
    const key = 'filex.app.settings';
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...saved, conflictBehavior: 'skip' }));
  });
  await page.reload();

  const before = await page.getByRole('option').count();
  await upload(page, SECOND);

  await expect(tray(page)).toContainText('Skipped');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await tray(page).getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await expect(page.getByRole('option')).toHaveCount(before);
});
