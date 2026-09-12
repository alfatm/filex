import { test, expect, type Page } from '@playwright/test';

/**
 * §28 of the audit, the two measurable findings: selection checkboxes were 20×20 — under the 24×24 WCAG 2.5.8
 * minimum — and two text elements fell short of the 4.5:1 AA contrast ratio at 3.97:1. The audit never named the
 * two, so the ratio is measured over every piece of text the page paints rather than over a list of suspects.
 *
 * Both are measured here rather than asserted from the stylesheet: what matters is the geometry and the colour a
 * browser actually paints, and either can be changed by a class three levels up.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
/** WCAG 2.5.8 target size (minimum). */
const MIN_TARGET_PX = 24;
/** WCAG 1.4.3 contrast (minimum) for body text. */
const MIN_CONTRAST = 4.5;

const FOLDER = 'A11y E2E';

test.describe.configure({ mode: 'serial' });

/** Opens the fixture folder in list view — the rows, the checkboxes and the metadata columns are all there. */
async function listing(page: Page, ...segments: string[]) {
  await page.goto(['files', DRIVE, ...segments].map(encodeURIComponent).join('/'));
  const list = page.getByRole('radio', { name: 'List view' });
  await expect(list).toBeVisible();
  if ((await list.getAttribute('aria-checked')) !== 'true') await list.click();
  await expect(page.getByRole('grid')).toBeVisible();
}

test('the fixture: a folder holding a few rows to measure', async ({ page }) => {
  await page.goto(['files', DRIVE].map(encodeURIComponent).join('/'));
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'New folder' }).fill(FOLDER);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('heading', { name: 'New folder' })).toBeHidden();

  await page.goto(['files', DRIVE, FOLDER].map(encodeURIComponent).join('/'));
  await page.getByRole('navigation').getByRole('button', { name: 'New' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menu', { name: 'New' }).getByRole('menuitem', { name: 'Upload files' }).click();
  await (await chooser).setFiles([
    { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('one\n') },
    { name: 'two.md', mimeType: 'text/markdown', buffer: Buffer.from('# two\n') },
  ]);
  const tray = page.getByRole('region', { name: /^Uploading|uploads? complete$/ });
  await expect(tray.getByText(/uploads? complete/)).toBeVisible({ timeout: 60_000 });
  await tray.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await expect(page.getByText('one.txt', { exact: true })).toBeVisible();
});

test('a row checkbox is at least 24×24 to hit', async ({ page }) => {
  await listing(page, FOLDER);
  const boxes = page.getByRole('grid').getByRole('checkbox');
  const count = await boxes.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < Math.min(count, 5); i++) {
    // The drawn box stays the design's 20×20; what is measured is what a pointer can land on, which an overlay
    // widens without moving anything on screen.
    const target = await boxes.nth(i).evaluate((el) => {
      const own = el.getBoundingClientRect();
      const before = getComputedStyle(el, '::before');
      const grow = (value: string) => (value.endsWith('px') ? -parseFloat(value) * 2 : 0);
      return {
        width: own.width + grow(before.insetInlineStart),
        height: own.height + grow(before.insetBlockStart),
      };
    });
    expect(target.width, `checkbox ${i} width`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(target.height, `checkbox ${i} height`).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  }
});

test('every piece of text on screen meets AA contrast', async ({ page }) => {
  await listing(page, FOLDER);

  // Measured in the page: the painted colour of each leaf text node against the first ancestor that actually has
  // a background. A stylesheet cannot answer this — a token, a hover class and an opacity all land on the same
  // pixel, and the ratio is a property of the pixel.
  const failures = await page.evaluate(
    ({ min }) => {
      const parse = (color: string): [number, number, number, number] => {
        const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      };
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const over = (fg: number[], bg: number[]) => {
        const a = fg[3];
        return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
      };
      /** The colour actually behind an element: the nearest ancestor painting something opaque enough to see. */
      const backdrop = (el: Element): number[] => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const color = parse(getComputedStyle(node).backgroundColor);
          if (color[3] > 0.5) return color.slice(0, 3);
        }
        return [255, 255, 255];
      };

      const out: { text: string; ratio: number; tag: string }[] = [];
      // The whole page, not only the listing: the sidebar, the header and the filter chips carry as much text as
      // the rows do, and the audit's two failing elements were never named.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set<Element>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const el = node.parentElement;
        if (!text || !el || seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        // Large text (18.66px bold / 24px) has a lower bar; nothing here is that size, so it is simply skipped.
        if (parseFloat(style.fontSize) >= 24) continue;

        const bg = backdrop(el);
        const fg = over(parse(style.color), bg);
        const light = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
        const ratio = (light[0] + 0.05) / (light[1] + 0.05);
        if (ratio < min) out.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, tag: el.tagName });
      }
      return out;
    },
    { min: MIN_CONTRAST },
  );

  expect(failures, `text below ${MIN_CONTRAST}:1 — ${JSON.stringify(failures, null, 2)}`).toEqual([]);
});
