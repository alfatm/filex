import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRepository } from './repository';
import type { WireFileNode } from './map';

/** One recorded call, in the order the repository made it. */
interface Call {
  url: string;
  method: string;
  body: unknown;
  headers?: Record<string, string>;
}

const calls: Call[] = [];
/**
 * URL substring → what the fake server answers. First match wins, so specific routes go before general ones.
 * A function answers per call, for an endpoint whose reply moves (the upload offset).
 */
let routes: [string, unknown | ((call: Call) => unknown)][] = [];

function answer(call: Call): unknown {
  const route = routes.find(([pattern]) => call.url.includes(pattern));
  if (!route) throw new Error(`no stub for ${call.url}`);
  return typeof route[1] === 'function' ? (route[1] as (c: Call) => unknown)(call) : route[1];
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    // A chunk body is bytes, not JSON: record its length instead of trying to parse it.
    const raw = init?.body;
    const body = raw instanceof Blob ? { bytes: raw.size } : raw ? JSON.parse(String(raw)) : undefined;
    const call: Call = { url, method: init?.method ?? 'GET', body, headers: init?.headers as Record<string, string> | undefined };
    calls.push(call);
    return { ok: true, status: 200, text: async () => JSON.stringify(answer(call)) } as Response;
  });
});

afterEach(() => vi.unstubAllGlobals());

const row = (patch: Partial<WireFileNode>): WireFileNode => ({
  id: 1,
  path: 'main://Docs',
  basename: 'Docs',
  type: 'dir',
  extension: '',
  size: 0,
  storage: 'main',
  last_modified: Date.parse('2026-07-01T10:00:00Z'),
  ...patch,
});

const index = (...files: WireFileNode[]) => ({ adapter: 'main', storages: ['main'], dirname: 'main://', read_only: false, files });

describe('HttpRepository', () => {
  it('lists a drive by name and shares the account quota across every drive', async () => {
    routes = [
      ['/api/files/storages', { storages: [{ name: 'main', read_only: false }, { name: 'archive', read_only: true }] }],
      ['/api/files/quota/me', { used_bytes: 250, quota_bytes: 1000 }],
    ];
    const storages = await new HttpRepository().listStorages();
    expect(storages).toEqual([
      { id: 'main', name: 'main', rootId: 'main://', quota: { usedBytes: 250, totalBytes: 1000 } },
      { id: 'archive', name: 'archive', rootId: 'archive://', quota: { usedBytes: 250, totalBytes: 1000 } },
    ]);
  });

  it('addresses a listing by path and folds in the starred flag the listing cannot report', async () => {
    routes = [
      ['star/list', { nodes: [{ id: 2, storage_id: 1, name: 'report.pdf', path: '/Docs/report.pdf', type: 'file', size: 5, storage: 'main' }] }],
      ['q=index', index(row({ id: 3, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }), row({ id: 2, path: 'main://Docs/report.pdf', basename: 'report.pdf', type: 'file' }))],
    ];
    const files = await new HttpRepository().listFolder('main://Docs');
    expect(files.map((n) => [n.name, n.starred])).toEqual([['notes.md', false], ['report.pdf', true]]);
    expect(calls[0].url).toContain('path=main%3A%2F%2FDocs');
  });

  it('derives the ancestor chain from the address without asking the server', async () => {
    routes = [];
    const chain = await new HttpRepository().getPath('main://Docs/2026/report.pdf');
    expect(chain.map((n) => [n.id, n.name])).toEqual([['main://', 'main'], ['main://Docs', 'Docs'], ['main://Docs/2026', '2026']]);
    expect(calls).toEqual([]);
  });

  it('creates a folder under the parent address and answers with the row the server now lists', async () => {
    routes = [['q=index', index(row({ id: 8, path: 'main://Docs/Reports', basename: 'Reports' }))], ['q=newfolder', { ok: true }]];
    const created = await new HttpRepository().createFolder('main://Docs', 'Reports');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { path: 'main://Docs', name: 'Reports' } });
    expect(created).toMatchObject({ id: 'main://Docs/Reports', name: 'Reports', kind: 'folder' });
  });

  it('sends the numeric id to the metadata endpoints, learning it from the listing', async () => {
    routes = [['star/list', { nodes: [] }], ['q=index', index(row({ id: 42, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))], ['manager/tags', { ok: true }]];
    const repo = new HttpRepository();
    await repo.listFolder('main://Docs');
    await repo.setTags('main://Docs/notes.md', ['draft']);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { node_id: 42, tags: ['draft'] } });
  });

  it('refuses to guess a numeric id for a node it has never listed', async () => {
    routes = [];
    await expect(new HttpRepository().setTags('main://Docs/unseen.md', [])).rejects.toThrow('no node id known');
    expect(calls).toEqual([]);
  });

  it('patches only the profile fields it was given, in the server\u2019s own spelling', async () => {
    routes = [['/api/auth/profile', { id: 1, email: 'ada@filex.test', display_name: 'Ada', role: 'user', locale: 'ru', timezone: 'Europe/Berlin' }]];
    const user = await new HttpRepository().updateProfile({ name: 'Ada', locale: 'ru' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { display_name: 'Ada', locale: 'ru' } });
    // An untouched field must not be sent at all: an explicit "" is how the server is told to CLEAR one.
    expect(calls[0].body).not.toHaveProperty('avatar_url');
    expect(calls[0].body).not.toHaveProperty('timezone');
    expect(user).toMatchObject({ id: '1', name: 'Ada', initial: 'A', locale: 'ru', timeZone: 'Europe/Berlin' });
  });

  it('falls back to the sign-in address when the account has no display name', async () => {
    routes = [['/api/auth/me', { user: { id: 2, email: 'nobody@filex.test', display_name: '', role: 'user' } }]];
    expect(await new HttpRepository().currentUser()).toMatchObject({ name: 'nobody@filex.test', initial: 'N' });
  });

  it('tells a wrong current password apart from a server failure', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '{"error":"old password incorrect"}' }) as Response);
    await expect(new HttpRepository().changePassword('nope', 'longenough')).rejects.toThrow('wrongPassword');
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => '{"error":"boom"}' }) as Response);
    await expect(new HttpRepository().changePassword('nope', 'longenough')).rejects.toThrow('500');
  });

  it('reports a name collision as the shared duplicate error the modals show inline', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, text: async () => '{"error":"exists"}' }) as Response);
    await expect(new HttpRepository().createFolder('main://Docs', 'Reports')).rejects.toThrow('duplicateName');
  });

  it('restores a node it trashed itself, without a trash listing to name its number', async () => {
    routes = [
      ['q=index', index(row({ id: 7, path: 'main://Docs', basename: 'Docs' }))],
      ['/star/list', { nodes: [] }],
      ['/api/files/delete', { op: { id: 3, kind: 'delete', status: 'ok' } }],
      ['/manager/restore', {}],
    ];
    const repo = new HttpRepository();
    // The listing is what teaches the repository that main://Docs is node 7.
    await repo.listFolder('main://');
    await repo.moveToTrash(['main://Docs']);
    await repo.restore(['main://Docs']);

    // Undo restores by number: dropping the path from the live map must not lose it.
    const restore = calls.find((c) => c.url.includes('/manager/restore'));
    expect(restore?.body).toEqual({ node_id: 7 });
  });

  it('moves through the ops queue and polls the job to its end', async () => {
    let asked = 0;
    routes = [
      ['/api/files/ops/5', () => ({ id: 5, kind: 'move', status: ++asked > 1 ? 'ok' : 'running' })],
      ['/api/files/move', { op: { id: 5, kind: 'move', status: 'pending' } }],
      ['q=index', index()],
      ['/star/list', { nodes: [] }],
    ];
    await new HttpRepository().move(['main://Docs/a.txt'], 'main://Reports');

    const submit = calls[0];
    expect(submit.method).toBe('POST');
    expect(submit.url).toContain('/api/files/move');
    expect(submit.body).toEqual({ source: ['main://Docs/a.txt'], target: 'main://Reports' });
    // Submitted pending, so the answer is the poll's, not the submit's: it is asked until the row is finished.
    expect(asked).toBe(2);
  });

  it('a job that outlives the wait is reported as pending, not as done and not as failed', async () => {
    vi.useFakeTimers();
    try {
      routes = [
        ['/api/files/ops/6', { id: 6, kind: 'delete', status: 'running' }],
        ['/api/files/delete', { op: { id: 6, kind: 'delete', status: 'running' } }],
      ];
      const pending = new HttpRepository().moveToTrash(['main://Docs']);
      const settled = expect(pending).rejects.toThrow('operationPending');
      await vi.advanceTimersByTimeAsync(70_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the trash for one row per deletion, not for everything a deleted folder contained', async () => {
    routes = [
      [
        '/manager/trash',
        {
          entries: [
            { id: 9, storage_id: 1, storage_name: 'main', path: '/Design', name: 'Design', size: 0, deleted_at: '2026-07-10T12:00:00Z' },
          ],
        },
      ],
    ];
    const trashed = await new HttpRepository().listTrash();
    expect(calls[0].url).toContain('top_level_only=1');
    expect(trashed.map((n) => n.id)).toEqual(['main://Design']);
  });

  it('addresses an archive download by every path in the selection', async () => {
    const repo = new HttpRepository();
    const node = (id: string, name: string) => ({ id, name }) as never;
    // A folder and a file at once: the archive is the only way the folder can travel.
    expect(repo.archiveUrl([node('main://Design', 'Design'), node('main://notes.md', 'notes.md')])).toBe(
      '/api/files/download/zip?path=main%3A%2F%2FDesign&path=main%3A%2F%2Fnotes.md',
    );
    // One thing selected names the file it lands in.
    expect(repo.archiveUrl([node('main://Design', 'Design')])).toBe('/api/files/download/zip?path=main%3A%2F%2FDesign&name=Design.zip');
    expect(repo.archiveUrl([])).toBeNull();
  });

  it('uploads through the staged path: one session, chunks on the grid, then the commit’s op', async () => {
    routes = [
      ['/upload/begin', { id: 'u1', chunk_size: 4, offset: 0 }],
      // Before the bare session route, or the commit would match it.
      ['/upload/u1/commit', { op_id: 11 }],
      // The server's offset is the resume point, so the client must take it rather than count its own bytes.
      ['/upload/u1', (call: Call) => ({ offset: Number(/bytes \d+-(\d+)\//.exec(String(call.headers?.['content-range']))![1]) + 1 })],
      ['/api/files/ops/11', { id: 11, kind: 'upload-commit', status: 'ok' }],
      ['/star/list', { nodes: [] }],
      ['q=index', index(row({ id: 5, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file', size: 10 }))],
    ];
    const seen: number[] = [];
    const node = await new HttpRepository().uploadFile(
      'main://Docs',
      { name: 'notes.md', size: 10, blob: new Blob(['0123456789']) },
      { onProgress: (sent) => seen.push(sent) },
    );

    expect(calls[0]).toMatchObject({ method: 'POST', body: { path: 'main://Docs', name: 'notes.md', size: 10 } });
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.headers?.['content-range'])).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    // The last chunk is the remainder, not a padded full chunk.
    expect(puts.map((c) => c.body)).toEqual([{ bytes: 4 }, { bytes: 4 }, { bytes: 2 }]);
    // Bytes the server has taken, ending at the whole file.
    expect(seen).toEqual([0, 4, 8, 10]);
    expect(calls.some((c) => c.url.includes('/api/files/ops/11'))).toBe(true);
    expect(node).toMatchObject({ id: 'main://Docs/notes.md', name: 'notes.md' });
  });

  it('fails the upload when the transfer to the storage fails, not when filex has merely staged it', async () => {
    routes = [
      ['/upload/begin', { id: 'u2', chunk_size: 16, offset: 0 }],
      ['/upload/u2/commit', { op_id: 12 }],
      ['/upload/u2', {}],
      ['/api/files/ops/12', { id: 12, kind: 'upload-commit', status: 'failed', error: 'storage offline' }],
    ];
    await expect(
      new HttpRepository().uploadFile('main://Docs', { name: 'a.txt', size: 3, blob: new Blob(['abc']) }),
    ).rejects.toThrow('storage offline');
  });

  it('copies through the ops queue and waits for the job to finish', async () => {
    let polled = 0;
    routes = [
      ['/api/files/ops/', { id: 3, kind: 'copy', status: 'ok' }],
      ['/api/files/copy', { op: { id: 3, kind: 'copy', status: 'pending' } }],
    ];
    const repo = new HttpRepository();
    await repo.copy(['main://Docs/a.txt'], 'main://Backup');
    polled = calls.filter((c) => c.url.includes('/api/files/ops/3')).length;

    expect(calls.find((c) => c.url.includes('/api/files/copy'))?.body).toEqual({ source: ['main://Docs/a.txt'], target: 'main://Backup' });
    // Submitted, then polled until the row was no longer pending.
    expect(polled).toBe(1);
  });

  it('surfaces a failed copy job as an error rather than a silent no-op', async () => {
    routes = [
      ['/api/files/ops/', { id: 4, kind: 'copy', status: 'failed', error: 'destination is read-only' }],
      ['/api/files/copy', { op: { id: 4, kind: 'copy', status: 'running' } }],
    ];
    await expect(new HttpRepository().copy(['main://a.txt'], 'main://ro')).rejects.toThrow('destination is read-only');
  });
});
