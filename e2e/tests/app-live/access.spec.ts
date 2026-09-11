import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * `Manage access` on the BUILT bundle, in all three locales.
 *
 * The audit found the modal never mounted: two `Something went wrong` toasts and `SyntaxError: Invalid linked
 * format` out of the vue-i18n message compiler, with no HTTP call in sight — `@` in `modal.access.emailPlaceholder`
 * read as the start of a linked message. A unit test covering exactly that message was green, because vitest runs
 * a different build of vue-i18n than the bundle does; so the probe that can hold this is one against the artefact,
 * watching the console rather than only the DOM.
 *
 * Every label comes from the locale files rather than being spelled out here: the point is that all three compile.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Access E2E';
const LOCALES = ['en', 'ru', 'tr'] as const;

const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(new URL(`../../../app/src/locales/${l}.json`, import.meta.url), 'utf8'))]),
) as Record<(typeof LOCALES)[number], unknown>;

function label(locale: (typeof LOCALES)[number], path: string): string {
  const value = path.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], messages[locale]);
  if (typeof value !== 'string') throw new Error(`${locale}: no message at ${path}`);
  return value;
}

test.describe.configure({ mode: 'serial' });

function card(page: Page, name: string) {
  return page.getByRole('option').filter({ has: page.getByText(name, { exact: true }) });
}

/**
 * The language lives on the ACCOUNT — `AppShell` overwrites the browser's stored choice with the profile's at
 * boot — so it is set where the settings modal sets it, through the profile endpoint, rather than in localStorage.
 */
async function useLocale(page: Page, locale: (typeof LOCALES)[number]) {
  const res = await page.request.patch('/api/auth/profile', { data: { locale } });
  expect(res.ok(), `could not set the account language to ${locale}: ${res.status()}`).toBeTruthy();
}

async function open(page: Page, locale: (typeof LOCALES)[number]) {
  await useLocale(page, locale);
  await page.goto(`files/${encodeURIComponent(DRIVE)}`);
  const grid = page.getByRole('radio', { name: label(locale, 'files.gridView') });
  await expect(grid).toBeVisible();
  if ((await grid.getAttribute('aria-checked')) !== 'true') await grid.click();
}

test('the fixture: a folder to hand out', async ({ page }) => {
  await open(page, 'en');
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();
  await expect(card(page, FOLDER)).toBeVisible();
});

for (const locale of LOCALES) {
  test(`Manage access opens in ${locale} with a clean console`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page, locale);
    await card(page, FOLDER).getByRole('button', { name: label(locale, 'files.more') }).click();
    const menu = page.getByRole('menu', { name: label(locale, 'files.more') });
    await menu.getByRole('menuitem', { name: label(locale, 'menu.manageAccess'), exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: label(locale, 'modal.access.title') })).toBeVisible();
    // The escaped literal `@` the compiler used to choke on has to reach the field as itself.
    await expect(dialog.getByRole('textbox').first()).toHaveAttribute('placeholder', /@/);
    // A toast would mean the modal reported a failure even if it drew.
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors, `the modal logged: ${errors.join(' | ')}`).toEqual([]);
  });
}

/**
 * The other half of §12: a grant has to reach a real second account, and be removable again. The modal drawing is
 * only the first step — the audit could not check any of this because the modal never opened.
 */
const GUEST_EMAIL = 'access-guest@filex.test';
const GUEST_PASSWORD = 'Guest!Passw0rd';

/**
 * Per-item grants only exist on a drive with RBAC on, and the harness seeds one with it off — the modal then
 * answers "Access rules are off for this drive", correctly and uselessly for this probe. So the flag is turned on
 * for the drive here and put back afterwards, rather than changed for every other spec in the suite.
 */
async function setRbac(page: Page, enabled: boolean) {
  const list = await page.request.get('/api/admin/storages');
  expect(list.ok(), `could not read the storages: ${list.status()}`).toBeTruthy();
  const rows = (await list.json()) as { id: number; name: string }[];
  const drive = rows.find((s) => s.name === DRIVE);
  expect(drive, `no storage named ${DRIVE}`).toBeTruthy();
  const patched = await page.request.patch(`/api/admin/storages/${drive!.id}`, { data: { rbac_enabled: enabled } });
  expect(patched.ok(), `could not set rbac_enabled=${enabled}: ${patched.status()} ${await patched.text()}`).toBeTruthy();
}

// ⚠ Last in the file on purpose: it opens the app in English, which puts the account's language back where the
// locale walk above left it — the language is the ACCOUNT's, so it would otherwise reach every later spec.
test('a grant by e-mail reaches the other account, and revoking takes it away', async ({ page, browser }) => {
  await setRbac(page, true);
  const created = await page.request.post('/api/admin/users', {
    data: { email: GUEST_EMAIL, password: GUEST_PASSWORD, role: 'user' },
  });
  expect(created.ok(), `could not create the recipient: ${created.status()} ${await created.text()}`).toBeTruthy();

  await open(page, 'en');
  await card(page, FOLDER).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Manage access', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Manage access' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Email address' }).fill(GUEST_EMAIL);
  await dialog.getByRole('combobox', { name: 'Role' }).selectOption('viewer');
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();

  // The list is the record of the grant; a public link instead would mean the address matched no account.
  const people = dialog.getByRole('list', { name: 'People with access' });
  await expect(people).toContainText(GUEST_EMAIL);
  await expect(dialog.getByText('a public link was created instead')).toHaveCount(0);

  // The recipient's own session — the only proof the grant left the owner's browser.
  const guest = await browser.newContext();
  try {
    const signedIn = await guest.request.post('/api/auth/login', { data: { email: GUEST_EMAIL, password: GUEST_PASSWORD } });
    expect(signedIn.ok(), `the recipient could not sign in: ${signedIn.status()}`).toBeTruthy();
    const guestPage = await guest.newPage();
    await guestPage.goto('shared');
    await expect(guestPage.getByText(FOLDER, { exact: true }).first()).toBeVisible();

    await dialog.getByRole('button', { name: `Remove ${GUEST_EMAIL}` }).click();
    await expect(people).not.toContainText(GUEST_EMAIL);

    await guestPage.reload();
    await expect(guestPage.getByText(FOLDER, { exact: true })).toHaveCount(0);
  } finally {
    await guest.close();
    await setRbac(page, false);
  }
});
