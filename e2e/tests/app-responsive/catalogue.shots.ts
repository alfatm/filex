import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The screenshot catalogue: every screen of `app/`, at every width, in both themes — `run.mjs app-responsive --shots`.
 *
 * It asserts NOTHING on purpose. Reviewing an adaptive layout is a thing eyes do, and the alternative measured in
 * practice is clicking through three window sizes by hand and missing the screen nobody thought of. Pinned
 * baselines (`toHaveScreenshot`) are a different tool for a different question — "did this change?" — and they
 * belong on the shell alone, generated in a container, once the layout has stopped moving.
 *
 * Output: `shots/app/<viewport>/<theme>/<screen>.png` plus an `index.html` contact sheet. `shots/` is git-ignored;
 * these pictures are for looking at, not for keeping.
 *
 * ⚠ A screen that cannot be reached is SKIPPED with a note, never a failure: the catalogue runs while the layout
 * is being rebuilt, and a control that moved to a drawer must not stop the other twenty pictures from being taken.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(REPO, 'shots', 'app');
const DRIVE = process.env.E2E_APP_STORAGE ?? '';

const drive = (...segments: string[]) => ['files', DRIVE, ...segments].map(encodeURIComponent).join('/');

/**
 * Every screen worth a picture, as the steps that reach it from a fresh page.
 *
 * `touch` is what the viewport's finger would do: a tap is not a click with a different name — it carries its own
 * event sequence and its own focus behaviour, and a menu that a mouse opens is not proof that a thumb can.
 */
const SCREENS: { name: string; open: (page: Page, touch: boolean) => Promise<void>; only?: string }[] = [
  { name: '01-files-grid', open: async (page) => { await page.goto(drive()); await view(page, 'Grid view'); } },
  { name: '02-files-list', open: async (page) => { await page.goto(drive()); await view(page, 'List view'); } },
  {
    name: '03-details',
    open: async (page) => {
      await page.goto(drive('Documents'));
      // ⚠ The view mode is PERSISTED (localStorage), so the list view left behind by screen 02 is still in force
      // here — and a list has rows, not options. Every screen that reaches for a card asks for the grid first.
      await view(page, 'Grid view');
      await page.getByRole('option').first().click({ timeout: 10_000 });
      const toggle = page.getByRole('button', { name: 'Details', exact: true });
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
      // ⚠ Not `complementary`: the panel is an <aside> only where it has a column of its own. As an overlay or a
      // sheet it is a dialog panel, so the wait is for something the panel PAINTS in all three shapes.
      await page.getByRole('tab', { name: 'Activity' }).waitFor({ timeout: 10_000 });
    },
  },
  { name: '04-folder', open: async (page) => { await page.goto(drive('Design')); } },
  {
    name: '05-new-menu',
    open: async (page) => {
      await page.goto(drive());
      await page.getByRole('button', { name: 'New' }).first().click();
      await page.getByRole('menu', { name: 'New' }).waitFor({ timeout: 5_000 });
    },
  },
  {
    name: '06-item-menu',
    open: async (page) => {
      await page.goto(drive('Documents'));
      await view(page, 'List view');
      await page.getByRole('grid').locator('tbody tr').first().getByRole('button', { name: 'More' }).click();
      await page.getByRole('menu', { name: 'More' }).waitFor({ timeout: 5_000 });
    },
  },
  {
    name: '07-search',
    open: async (page) => {
      await page.goto(drive());
      const box = await searchBox(page);
      await box.click();
      await box.fill('report');
      await box.press('Enter');
      await page.waitForURL(/search/, { timeout: 10_000 });
    },
  },
  {
    name: '08-advanced-search',
    open: async (page) => {
      await page.goto(drive());
      await searchBox(page);
      await page.getByRole('button', { name: 'Advanced search' }).click();
      // ⚠ Never `getByRole('dialog')` with the default `visible` state: headlessui renders an outer dialog node
      // with no box at all, so the wait times out while the modal is plainly on screen. Wait for its heading.
      await page.getByRole('heading', { name: 'Advanced search' }).waitFor({ timeout: 10_000 });
    },
  },
  {
    name: '09-settings',
    open: async (page) => {
      await page.goto(drive());
      await openSettings(page);
      await page.getByRole('heading', { name: 'User settings' }).waitFor({ timeout: 5_000 });
    },
  },
  { name: '10-recent', open: async (page) => { await page.goto('recent'); } },
  { name: '11-starred', open: async (page) => { await page.goto('starred'); } },
  { name: '12-shared', open: async (page) => { await page.goto('shared'); } },
  { name: '13-trash', open: async (page) => { await page.goto('trash'); } },
  { name: '14-home', open: async (page) => { await page.goto('home'); } },
  {
    // Phone only: the sidebar is a drawer there and a drawer nobody opens is a screen nobody reviews. The wider
    // layouts have no drawer at all, which is the design rather than a miss — hence `only`, so the run does not
    // report four failures every time and teach the eye to skim past skips.
    name: '16-drawer',
    only: 'phone',
    open: async (page) => {
      await page.goto(drive());
      await page.getByRole('button', { name: 'Open menu' }).click({ timeout: 3_000 });
      await page.getByRole('dialog').getByRole('navigation').waitFor({ timeout: 5_000 });
    },
  },
  {
    name: '17-selection',
    open: async (page) => {
      await page.goto(drive('Documents'));
      // The row checkboxes, not a modifier-click on cards: ⌘/Ctrl-click is a mouse idiom, and on a touch-enabled
      // context it picked one row on some widths and two on others — the shot is about the bar, not about how the
      // selection was made.
      await view(page, 'List view');
      const boxes = page.getByRole('grid').getByRole('checkbox');
      await boxes.nth(1).click({ timeout: 10_000 });
      await boxes.nth(2).click();
      await page.getByRole('toolbar', { name: /selected/ }).waitFor({ timeout: 5_000 });
    },
  },
  {
    name: '15-preview',
    open: async (page) => {
      await page.goto(drive('Photos'));
      await view(page, 'Grid view');
      await page.getByRole('option').first().dblclick({ timeout: 10_000 });
      // Same headlessui trap as the advanced-search modal: wait for something the preview actually paints.
      await page.getByRole('button', { name: 'Close' }).first().waitFor({ timeout: 15_000 });
    },
  },
  {
    // The chip menu, opened by a TAP where there is a finger.
    //
    // It is here because it was invisible below `xl` for as long as the chips have been a side-scroller: the
    // scroller's `mask-image` clipped the menu away while leaving it in the DOM, which is a state no assertion on
    // "is it visible" catches — only the picture does.
    name: '18-filter-menu',
    open: async (page, touch) => {
      await page.goto(drive());
      const chip = page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Type' });
      await chip.waitFor({ timeout: 10_000 });
      if (touch) await chip.tap();
      else await chip.click();
      await page.getByRole('menu', { name: 'Type' }).waitFor({ timeout: 5_000 });
    },
  },
];

/**
 * The search field, wherever this width keeps it: a field on a tablet and a desktop, an icon on a phone that has
 * to be pressed before the field exists at all (spec §10).
 */
async function searchBox(page: Page) {
  const icon = page.getByRole('button', { name: 'Search', exact: true });
  if (await icon.isVisible().catch(() => false)) await icon.click();
  const box = page.getByRole('searchbox', { name: 'Search' });
  await box.waitFor({ timeout: 5_000 });
  return box;
}

/** Settings: an icon in the bar on a desktop, an entry in the account menu below `xl`. */
async function openSettings(page: Page) {
  const gear = page.getByRole('button', { name: 'Settings', exact: true });
  if (await gear.isVisible().catch(() => false)) return gear.click();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'User settings' }).click();
}

/** Switches the listing to one of the two views when the control is on screen; a layout without it is fine. */
async function view(page: Page, name: 'Grid view' | 'List view') {
  const radio = page.getByRole('radio', { name });
  // ⚠ Wait for the control before asking about it. `goto` resolves on the document, not on the app: measured, the
  // toolbar did not exist yet, `isVisible()` answered false, this helper returned in silence — and every "list
  // view" picture in the catalogue was a picture of the grid. A screen with no toggle at all still returns here,
  // but only after the wait has had its say.
  await radio.waitFor({ timeout: 10_000 }).catch(() => undefined);
  if (!(await radio.isVisible().catch(() => false))) return;
  if ((await radio.getAttribute('aria-checked')) === 'true') return;
  await radio.click();
  // Read the button back rather than waiting on a locator that could match somebody else's aria-checked: a shot
  // of the wrong view is indistinguishable from a shot of the right one until you look at it.
  await page
    .locator(`[role="radio"][aria-label="${name}"][aria-checked="true"]`)
    .waitFor({ timeout: 5_000 })
    .catch(() => {
      throw new Error(`clicking "${name}" did not switch the listing`);
    });
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });

    test(`catalogue (${theme})`, async ({ page }, testInfo) => {
      // Sixteen screens in one browser context: a test each would pay for a new context sixteen times over, and
      // there is nothing here to isolate — nothing writes.
      test.setTimeout(5 * 60_000);
      /*
       * ⚠ Wiped, not written over. A screen that can no longer be reached used to leave the PREVIOUS run's picture
       * in place — so the catalogue showed a layout that no longer existed anywhere, which is worse than showing
       * nothing. Measured: three phone screens sat two builds out of date and read as current.
       */
      const dir = path.join(OUT, testInfo.project.name, theme);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });

      // The two narrow projects declare `hasTouch`; `tap()` throws without it, so the desktop one stays on clicks.
      const touch = testInfo.project.name !== 'desktop';

      for (const screen of SCREENS) {
        if (screen.only && screen.only !== testInfo.project.name) continue;
        try {
          await screen.open(page, touch);
          // The shell animates nothing, but a thumbnail that arrives late makes two runs differ for no reason.
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
          await page.screenshot({ path: path.join(dir, `${screen.name}.png`) });
        } catch (err) {
          const why = (err as Error).message.split('\n')[0];
          testInfo.annotations.push({ type: 'skipped screen', description: `${screen.name}: ${why}` });
          // eslint-disable-next-line no-console -- the run's own report: a picture that was not taken.
          console.log(`[catalogue] ${testInfo.project.name}/${theme}: SKIPPED ${screen.name} — ${why}`);
        }
      }
    });
  });
}

/**
 * The contact sheet, rebuilt from whatever is on disk.
 *
 * Every project writes it when it finishes, so the last one to end produces the complete page — cheaper than a
 * teardown project that exists only to read a directory, and identical in the end.
 */
test.afterAll(() => {
  if (!fs.existsSync(OUT)) return;
  const viewports = fs.readdirSync(OUT).filter((d) => fs.statSync(path.join(OUT, d)).isDirectory());
  const screens = new Set<string>();
  for (const viewport of viewports) {
    for (const theme of fs.readdirSync(path.join(OUT, viewport))) {
      const themeDir = path.join(OUT, viewport, theme);
      if (!fs.statSync(themeDir).isDirectory()) continue;
      for (const file of fs.readdirSync(themeDir)) if (file.endsWith('.png')) screens.add(file.replace(/\.png$/, ''));
    }
  }

  const rows = [...screens].sort().map((screen) => {
    const cells = viewports
      .flatMap((viewport) => ['light', 'dark'].map((theme) => ({ viewport, theme })))
      .map(({ viewport, theme }) => {
        const rel = `${viewport}/${theme}/${screen}.png`;
        return fs.existsSync(path.join(OUT, rel))
          ? `<figure><img loading="lazy" src="${rel}" alt="${screen} ${viewport} ${theme}"><figcaption>${viewport} · ${theme}</figcaption></figure>`
          : '';
      })
      .join('');
    return `<section><h2>${screen}</h2><div class="row">${cells}</div></section>`;
  });

  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>filex app — responsive catalogue</title>
<style>
  body { margin: 0; padding: 24px; font: 13px/1.5 system-ui, sans-serif; background: #15171c; color: #e6e8ec; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.taken { margin: 0 0 24px; color: #888f9b; }
  section { margin-bottom: 32px; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .row { display: flex; gap: 16px; overflow-x: auto; align-items: flex-start; }
  figure { margin: 0; flex: 0 0 auto; }
  img { max-height: 460px; border: 1px solid #2e333c; border-radius: 8px; display: block; background: #fff; }
  figcaption { margin-top: 6px; color: #888f9b; }
</style>
<h1>filex app — responsive catalogue</h1>
<p class="taken">${new Date().toISOString()} · ${viewports.join(' · ')}</p>
${rows.join('\n')}
`,
  );
});
