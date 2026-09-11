import { test, expect, type Page } from '@playwright/test';

/**
 * §20 of the audit: what the app says when something goes wrong.
 *
 * The findings under test — the network dropping during in-app navigation left the screen exactly as it was, with
 * no message and nothing to retry; a name the server refuses as invalid (`..`) was reported as "an item with this
 * name already exists"; and `GET /api/files/manager/star/list` answered 500.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Errors E2E';

test.describe.configure({ mode: 'serial' });

function card(page: Page, name: string) {
  return page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
}

async function open(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const grid = page.getByRole('radio', { name: 'Grid view' });
  await expect(grid).toBeVisible();
  if ((await grid.getAttribute('aria-checked')) !== 'true') await grid.click();
}

/** Opens New folder and types `name`; `submit` is off for the names the dialog itself refuses. */
async function newFolder(page: Page, name: string, submit = true) {
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(name);
  if (submit) await dialog.getByRole('button', { name: 'Create' }).click();
  return dialog;
}

test('the fixture: one folder to navigate into', async ({ page }) => {
  await open(page);
  const dialog = await newFolder(page, FOLDER);
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();
  await expect(card(page, FOLDER)).toBeVisible();
});

test('a listing that cannot be fetched says so and offers to try again', async ({ page, context }) => {
  await open(page);
  // The rows have to be on screen BEFORE the network goes: `open` only waits for the shell, and cutting the
  // connection mid-load would test the first load rather than a navigation inside the app.
  await expect(card(page, FOLDER)).toBeVisible();
  await context.setOffline(true);
  try {
    await card(page, FOLDER).dblclick();
    // Not the previous screen left standing: a sentence, and a way out of it.
    await expect(page.getByText('Could not load this listing')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Could not load this listing')).toHaveCount(0);
});

test('a name the server refuses as invalid is not reported as a name that is taken', async ({ page }) => {
  await open(page);
  const dialog = await newFolder(page, '..', false);
  // `..` used to reach the server, be folded away by path.Join, resolve to the PARENT folder — which exists — and
  // come back as "an item with this name already exists": a sentence about something else entirely. The server
  // refuses it now, and the dialog no longer sends it at all — the same rule on both sides.
  await expect(dialog.getByRole('alert')).toHaveText('That name cannot be used');
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
  await dialog.getByText('Cancel', { exact: true }).click();
});

test('the starred listing answers, rather than 500', async ({ page }) => {
  const res = await page.request.get('/api/files/manager/star/list?limit=500');
  expect(res.status(), `starred listing answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);

  await page.goto('starred');
  await expect(page.getByRole('heading', { name: 'Starred', level: 1 })).toBeVisible();
  await expect(page.getByText('Could not load this listing')).toHaveCount(0);
});

/**
 * An account with no access to the drive at all.
 *
 * ⚠ What this measures is NOT the 403 path. With RBAC on, a drive the account has no grant on is not in its
 * adapter list, so the server answers `404 unknown adapter` and "Folder not found" is the honest sentence. The
 * 403 the audit saw comes from somewhere this stand cannot produce; the mapping that answers it — a refusal is
 * `forbidden`, not `notFound`, and carries no Try again — is pinned in `stores/files.navigate.test.ts` instead.
 */
const OUTSIDER_EMAIL = 'errors-outsider@filex.test';
const OUTSIDER_PASSWORD = 'Outsider!Passw0rd';

test('an account with no access to the drive is told the folder is not there, not that the load failed', async ({ page, browser }) => {
  const list = await page.request.get('/api/admin/storages');
  const drive = ((await list.json()) as { id: number; name: string }[]).find((s) => s.name === DRIVE);
  expect(drive, `no storage named ${DRIVE}`).toBeTruthy();
  const setRbac = async (enabled: boolean) => {
    const res = await page.request.patch(`/api/admin/storages/${drive!.id}`, { data: { rbac_enabled: enabled } });
    expect(res.ok(), `could not set rbac_enabled=${enabled}: ${res.status()}`).toBeTruthy();
  };

  const created = await page.request.post('/api/admin/users', {
    data: { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD, role: 'user' },
  });
  expect(created.ok(), `could not create the outsider: ${created.status()} ${await created.text()}`).toBeTruthy();
  await setRbac(true);

  const outsider = await browser.newContext();
  try {
    const signedIn = await outsider.request.post('/api/auth/login', { data: { email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD } });
    expect(signedIn.ok(), `the outsider could not sign in: ${signedIn.status()}`).toBeTruthy();
    const theirPage = await outsider.newPage();
    await theirPage.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));

    // A sentence about the address, not a blank page and not "check your connection".
    await expect(theirPage.getByText('Folder not found')).toBeVisible();
    await expect(theirPage.getByText('Could not load this listing')).toHaveCount(0);
  } finally {
    await outsider.close();
    await setRbac(false);
  }
});
