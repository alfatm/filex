import { test, expect, type Page } from '@playwright/test';

/**
 * §19 of the audit carries no verdict: the stand had no quota configured, so nothing the product does when an
 * account runs out of room had ever been seen. This spec configures one — the admin quota endpoints are part of
 * the same server the suite already drives — and then asks the two questions that matter to somebody who hit it:
 * does the sidebar say how much room is left BEFORE the upload, and does the refusal afterwards say WHY.
 *
 * ⚠ The quota it sets belongs to the deterministic admin every other spec runs as, so `afterAll` MUST clear it.
 * A leaked limit would make every later upload in this serial run fail for a reason that spec never mentions.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Quota E2E';
/** Small enough that one modest file cannot fit, large enough that the fixture folder itself is not the problem. */
const LIMIT_BYTES = 4 * 1024;
const BIG = Buffer.alloc(64 * 1024, 'q');

test.describe.configure({ mode: 'serial' });

/** The admin's own user id — the quota endpoints are keyed by user, and the suite signs in as exactly one. */
async function meId(page: Page): Promise<number> {
  const res = await page.request.get('/api/auth/me');
  expect(res.ok(), 'the session behind this run can read its own account').toBeTruthy();
  const body = await res.json();
  const id = body?.id ?? body?.user?.id;
  expect(typeof id, 'the account payload carries a numeric id').toBe('number');
  return id;
}

/** `0` is not "no quota" here but "inherit the instance default", which is what this account had before. */
async function setQuota(page: Page, bytes: number) {
  const id = await meId(page);
  const res = await page.request.post(`/api/admin/users/${id}/quota`, { data: { quota_bytes: bytes } });
  expect(res.ok(), `setting quota_bytes=${bytes} succeeded`).toBeTruthy();
}

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

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await setQuota(page, 0);
  await page.close();
});

test('the fixture: a folder to upload into, and a quota this account cannot fit', async ({ page }) => {
  await open(page);
  await newFolder(page, FOLDER);
  await setQuota(page, LIMIT_BYTES);
});

test('the sidebar states the limit before anything is uploaded', async ({ page }) => {
  await open(page, FOLDER);
  // ⚠ The LEFT rail, not `aside`: the details panel is an `aside` too and matches first. The quota line lives
  // under the drive name at the foot of the navigation.
  const rail = page.getByRole('navigation').first();
  await expect(rail).toContainText(/used/i);
  // Without a limit the line reads "N used"; with one it has to name the ceiling, or the bar promises nothing.
  await expect(rail, 'the sidebar names the limit, not only what is spent').toContainText(/of .* used/i);
});

test('an upload that does not fit says the account is full, not just “Upload failed”', async ({ page }) => {
  await open(page, FOLDER);
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles([{ name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: BIG }]);

  const tray = page.getByRole('region', { name: /^Uploading|uploads? (complete|failed)$/ });
  await expect(tray.getByText(/upload failed/i)).toBeVisible({ timeout: 60_000 });
  // The point of the probe: the row has to name the quota. "Upload failed" alone sends the person looking for a
  // network problem they do not have, and there is nothing in the UI that would correct them.
  await expect(tray).toContainText(/quota|full|room|space|limit/i);
});
