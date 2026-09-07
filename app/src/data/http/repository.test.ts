import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRepository } from './repository';
import type { WireFileNode } from './map';

/** One recorded call, in the order the repository made it. */
interface Call {
  url: string;
  method: string;
  body: unknown;
}

const calls: Call[] = [];
/** URL substring → what the fake server answers. First match wins, so specific routes go before general ones. */
let routes: [string, unknown][] = [];

function answer(url: string): unknown {
  const route = routes.find(([pattern]) => url.includes(pattern));
  if (!route) throw new Error(`no stub for ${url}`);
  return route[1];
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, text: async () => JSON.stringify(answer(url)) } as Response;
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

  it('reports a name collision as the shared duplicate error the modals show inline', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, text: async () => '{"error":"exists"}' }) as Response);
    await expect(new HttpRepository().createFolder('main://Docs', 'Reports')).rejects.toThrow('duplicateName');
  });
});
