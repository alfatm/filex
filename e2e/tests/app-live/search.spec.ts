import { test, expect, type Page } from '@playwright/test';

/**
 * Search, against a REAL filex server: the Bleve index, the `-path:` exclusion the chips send, and the drive
 * picker's `storage_id`.
 *
 * It belongs in this suite rather than beside the unit tests for the reason the file next door states: none of it
 * can pass without a server. The rows are created through the UI, the index is the server's, and what the page
 * prints is what the handler answered — an exclusion that quietly stopped filtering, or a drive id the server
 * refused, shows up here and nowhere else.
 *
 * ⚠ Serial and stateful ON PURPOSE, like `files.spec.ts`: one drive, two folders, two files, one story.
 */

/** The drive the harness seeded. Node ids are `<drive>://path`, so nothing here can be guessed. */
const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const KEEP = 'Search Keep';
const SKIP = 'Search Skip';
/** One word in both filenames, so the search finds them and the folder is the only thing telling them apart. */
const WORD = 'alfatest';

test.describe.configure({ mode: 'serial' });

/** Rows of the results table. */
function results(page: Page) {
  return page.locator('main table tbody tr');
}

async function openFolder(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
}

async function makeFolder(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
}

async function upload(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('x\n') });
  const tray = page.getByRole('region', { name: /^Uploading|upload complete$/ });
  await expect(tray.getByText('1 upload complete')).toBeVisible({ timeout: 30_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
}

/**
 * Runs a search and waits for the answer.
 *
 * The count line is the wait: it is written from the server's response, so a page that still shows the previous
 * answer has not been asserted on yet.
 */
async function search(page: Page, query: string) {
  await page.goto(`search?q=${encodeURIComponent(query)}`);
  await expect(page.locator('main').getByText(/matching item/)).toBeVisible();
}

test('a file in each of two folders, for the search to tell apart', async ({ page }) => {
  await openFolder(page);
  await makeFolder(page, KEEP);
  await makeFolder(page, SKIP);

  await openFolder(page, KEEP);
  await upload(page, `${WORD}-keep.txt`);
  await openFolder(page, SKIP);
  await upload(page, `${WORD}-skip.txt`);
});

test('the server finds both by name', async ({ page }) => {
  await search(page, WORD);
  // The index is asynchronous about content but not about names: a node is indexed as it is created.
  await expect(results(page)).toHaveCount(2);
});

test('skipping a folder from its own row drops it from the answer, and the chip puts it back', async ({ page }) => {
  await search(page, WORD);

  await page.getByRole('button', { name: `Skip /${DRIVE}/${SKIP}` }).click();
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText(`${WORD}-keep.txt`);
  // The chip is the only record of what was left out — nothing counts it — so it has to name it.
  await expect(page.locator('main')).toContainText(`Except /${SKIP}`);
  // …and the exclusion is in the address, so the answer survives a reload rather than living in the store.
  expect(new URL(page.url()).searchParams.getAll('skip')).toEqual([SKIP]);
  await page.reload();
  await expect(results(page)).toHaveCount(1);

  await page.getByRole('button', { name: `Stop skipping /${SKIP}` }).click();
  await expect(results(page)).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('skip')).toBeNull();
});

test('the drive picker narrows to one drive and the server still answers', async ({ page }) => {
  await search(page, WORD);
  const picker = page.getByLabel('Drive');
  await expect(picker).toBeVisible();
  // "All drives" first, then the drives this account can open — the seeded one among them.
  await expect(picker.locator('option').first()).toHaveText('All drives');

  await picker.selectOption(DRIVE);
  // The drive travels as its row id; the files really are on it, so narrowing must not lose them. A server that
  // refused the id, or a client that sent the wrong one, answers with nothing here. Asserted BEFORE the URL,
  // because this one retries until the new answer lands and reading `page.url()` does not.
  await expect(results(page)).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get('drive')).toBe(DRIVE);
});

test('an exclusion with no query text is a listing of everything else', async ({ page }) => {
  await page.goto(`search?skip=${encodeURIComponent(SKIP)}`);
  await expect(page.locator('main').getByText(/matching item/)).toBeVisible();
  // Answered by the node table rather than the index — there is no text to rank — and the excluded folder's file
  // is the one thing that must not be in it.
  expect(await results(page).count()).toBeGreaterThan(0);
  await expect(page.locator('main')).not.toContainText(`${WORD}-skip.txt`);
});

// No cleanup, on purpose: `run.mjs app` gives every run a throwaway data dir, so the tree these tests build does
// not outlive them — the same reason the file suite next door leaves its own rows where they are.
