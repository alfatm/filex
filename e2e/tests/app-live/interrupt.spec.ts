import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * §25 of the audit carries no verdict because no interruption was ever modelled. There are two different
 * interruptions behind that one line, and only one of them is the client's:
 *
 *   the CLIENT goes away mid-operation — the tab is closed, the network drops;
 *   the SERVER goes away mid-operation — the process is killed while it is halfway through a tree.
 *
 * This spec answers the first. Copy and move are QUEUED JOBS on the server (`POST /api/files/copy` hands back an
 * op the app then polls), so a client that leaves cancels nothing: the question is whether the job still lands a
 * COMPLETE tree, or whether abandoning the poll leaves a half-copied folder that the UI then shows as real.
 *
 * The second interruption needs the server process killed and restarted under a live job, which this harness has
 * no handle on from inside a spec — it stays a stand exercise, and the audit line stays open for it.
 */

const DRIVE = process.env.E2E_APP_STORAGE ?? '';
const FOLDER = 'Interrupt E2E';
const SOURCE = 'source-tree';
const TARGET = 'copy-target';
/** Enough files that the job is still running when the client walks away, small enough not to slow the suite. */
const FILES = 400;

test.describe.configure({ mode: 'serial' });

async function storageRoot(page: Page): Promise<string> {
  const res = await page.request.get('/api/admin/storages');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const list: { name?: string; config?: { path?: string } }[] = body?.storages ?? body ?? [];
  const found = list.find((s) => s.name === DRIVE)?.config?.path;
  expect(found, `the seeded drive "${DRIVE}" reports a local path`).toBeTruthy();
  return found as string;
}

test('the fixture: a folder worth copying and somewhere to copy it', async ({ page }) => {
  test.setTimeout(180_000);
  // ⚠ Everything through the API. filex's listing is served from its own node cache once a drive has synced, so a
  // tree written straight onto the storage directory exists on disk and is invisible to every screen and to the
  // copy job's own bookkeeping — see the same note in scale.spec.ts.
  for (const [parent, name] of [
    [`${DRIVE}://`, FOLDER],
    [`${DRIVE}://${FOLDER}`, SOURCE],
    [`${DRIVE}://${FOLDER}`, TARGET],
    [`${DRIVE}://${FOLDER}/${SOURCE}`, 'nested'],
  ]) {
    const made = await page.request.post('/api/files/manager', { params: { q: 'newfolder' }, data: { path: parent, name } });
    expect(made.ok(), `created ${parent}/${name} (${made.status()})`).toBeTruthy();
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: 32 }, async () => {
      for (let i = next++; i < FILES; i = next++) {
        const into = i % 2 ? `${DRIVE}://${FOLDER}/${SOURCE}/nested` : `${DRIVE}://${FOLDER}/${SOURCE}`;
        const res = await page.request.post('/api/files/manager', {
          params: { q: 'newfile' },
          data: { path: into, name: `f-${String(i).padStart(4, '0')}.txt` },
        });
        expect(res.ok(), `created f-${i} (${res.status()})`).toBeTruthy();
      }
    }),
  );
});

test('a copy whose client walks away still lands the whole tree', async ({ page }) => {
  test.setTimeout(180_000);
  const started = await page.request.post('/api/files/copy', {
    data: { source: [`${DRIVE}://${FOLDER}/${SOURCE}`], target: `${DRIVE}://${FOLDER}/${TARGET}` },
  });
  expect(started.ok(), 'the copy was accepted as a job').toBeTruthy();
  const op = (await started.json())?.op;
  expect(op?.id, 'the server answered with an op to poll').toBeTruthy();

  // The client leaves at once — no polling from the app. This reads the row only to learn how the ABANDONED job
  // ended; the app itself asked nothing after the POST.
  const deadline = Date.now() + 120_000;
  let status = 'pending';
  while (Date.now() < deadline && (status === 'pending' || status === 'running')) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const res = await page.request.get(`/api/files/ops/${op.id}`);
    status = res.ok() ? ((await res.json())?.status ?? `http ${res.status()}`) : `http ${res.status()}`;
  }
  expect(status, 'the job finished on its own, rather than failing because nobody was listening').toBe('ok');

  // The bytes are where they belong: counted on disk, which is where a copy actually lands them.
  const root = await storageRoot(page);
  const copied = path.join(root, FOLDER, TARGET, SOURCE);
  expect(fs.existsSync(copied), 'the copied folder exists').toBeTruthy();
  // Half a tree is the failure this exists to catch: it looks like a real folder and is missing somebody's files.
  expect(fs.readdirSync(copied).length, 'the whole first level arrived on disk').toBe(FILES / 2 + 1);
  expect(fs.readdirSync(path.join(copied, 'nested')).length, 'and so did the level below it').toBe(FILES / 2);
});

/**
 * …but the screens do not show it. Measured: 201 entries on disk, and the listing answers 0 for the copied folder,
 * still 0 ten seconds later — so this is not the node cache catching up, it is a copy that writes the bytes and
 * never registers the rows. The level BELOW reads 200 only because it has no row of its own either, and a cache
 * miss is the one case where filex falls back to asking the driver; the folder that DOES have a row is answered
 * from the cache and comes back empty.
 *
 * ⚠ `test.fail()`, not `skip`: the defect is real and unfixed, and this is what makes the suite say so without
 * going red for a known thing. Fix the copy job and this test starts failing BECAUSE it passes, which is the
 * reminder to delete this line.
 */
test('…and the listing shows what was copied', async ({ page }) => {
  test.fail();
  test.setTimeout(180_000);
  const count = async (address: string) => {
    const res = await page.request.get('/api/files/manager', { params: { q: 'index', path: address } });
    return res.ok() ? ((await res.json())?.files ?? []).length : -res.status();
  };
  const top = await count(`${DRIVE}://${FOLDER}/${TARGET}/${SOURCE}`);
  const inner = await count(`${DRIVE}://${FOLDER}/${TARGET}/${SOURCE}/nested`);
  console.log(`[interrupt] the listing shows ${top} at the top and ${inner} below it`);
  expect(top, 'the listing shows the whole first level').toBe(FILES / 2 + 1);
  expect(inner, 'and the level below it').toBe(FILES / 2);
});
