import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRepository } from './repository';
import type { WireFileNode } from './map';
import type { SearchHit } from '../types';

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
  it('gives each drive its own usage, under the one ceiling the account has', async () => {
    routes = [
      [
        '/api/files/storages',
        { storages: [{ name: 'main', read_only: false, used_bytes: 200 }, { name: 'archive', read_only: true, used_bytes: 50 }] },
      ],
      ['/api/files/quota/me', { used_bytes: 250, quota_bytes: 1000 }],
    ];
    const storages = await new HttpRepository().listStorages();
    // The account's own 250 is the sum, not each drive's figure — which is what every card used to show.
    expect(storages).toEqual([
      { id: 'main', name: 'main', rootId: 'main://', quota: { usedBytes: 200, totalBytes: 1000 } },
      { id: 'archive', name: 'archive', rootId: 'archive://', quota: { usedBytes: 50, totalBytes: 1000 } },
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

  it('sends the advanced form as facets instead of sieving the answer', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search({
      text: 'rapor',
      scope: 'all',
      searchIn: 'current',
      folderPath: 'Docs/2026',
      modified: 'week',
      fileType: 'documents',
      tags: [],
      ownerId: '4',
      size: { preset: 'medium', min: null, max: null, unit: 'MB' },
      path: '',
      wholePhrase: false,
    });

    const body = calls[0].body as Record<string, unknown>;
    expect(calls[0].method).toBe('POST');
    expect(body.query).toBe('rapor');
    expect(body.path_prefix).toBe('/Docs/2026');
    // The taxonomy stays in the app: the server is told which extensions, never what "documents" means.
    expect(body.ext).toEqual(['md', 'pdf']);
    expect(body.size_min).toBe(1024 * 1024);
    expect(body.size_max).toBe(100 * 1024 * 1024);
    expect(body.owner_id).toBe(4);
    expect(typeof body.modified_after).toBe('number');
    // No storage id: the app addresses drives by name, so the server asks every drive the caller can see.
    expect(body).not.toHaveProperty('storage_id');
  });

  it('shows the owner a listing named, and offers everyone seen as a People option', async () => {
    routes = [
      ['/api/auth/me', { user: { id: 1, email: 'ada@filex.test', display_name: 'Ada Lovelace', role: 'admin' } }],
      [
        'q=index',
        index(
          row({ id: 1, path: 'main://hers.txt', basename: 'hers.txt', type: 'file', owner_id: 4, owner_name: 'Ayşe' }),
          row({ id: 2, path: 'main://found.txt', basename: 'found.txt', type: 'file' }),
        ),
      ],
      ['/star/list', { nodes: [] }],
    ];
    const repo = new HttpRepository();
    // The app loads the account before any listing (bootstrap does), which is what lets an unowned row be labelled
    // with the caller's real id rather than the "me" placeholder.
    await repo.currentUser();
    const listed = await repo.listFolder('main://');

    expect(listed.map((n) => [n.name, n.ownerId, n.ownerName])).toEqual([
      ['hers.txt', '4', 'Ayşe'],
      // A row filex named no owner for is the caller's own — everything they can see, they can see.
      ['found.txt', '1', undefined],
    ]);

    // The chip offers who was actually seen, plus the account itself.
    const people = await repo.listFilterPeople();
    expect(people.map((p) => [p.id, p.name]).sort()).toEqual([['1', 'Ada Lovelace'], ['4', 'Ayşe']]);
  });

  it('reads the activity feed and tells a rename from a move', async () => {
    routes = [
      [
        '/api/files/activity',
        {
          events: [
            { id: 3, event: 'file.moved', at: '2026-07-11T09:00:00Z', actor_id: 4, actor_name: 'Ayşe', meta: { from: '/Docs/eski.md', to: '/Docs/notes.md' } },
            { id: 2, event: 'file.moved', at: '2026-07-10T09:00:00Z', actor_id: 4, actor_name: 'Ayşe', meta: { from: '/eski.md', to: '/Docs/eski.md' } },
            { id: 1, event: 'file.uploaded', at: '2026-07-09T09:00:00Z', actor_id: 4, actor_name: 'Ayşe' },
            { id: 0, event: 'comment.added', at: '2026-07-09T10:00:00Z' },
          ],
        },
      ],
    ];
    const events = await new HttpRepository().listActivity('main://Docs/notes.md');

    expect(calls[0].url).toContain('path=main%3A%2F%2FDocs%2Fnotes.md');
    // The comment has no sentence in this panel, so it is dropped rather than mislabelled.
    expect(events.map((e) => e.kind)).toEqual(['renamed', 'moved', 'created']);
    // Same folder on both sides of the move: a rename, named by what it was called before.
    expect(events[0].detail).toBe('eski.md');
    // Different folder: a move, named by where it landed.
    expect(events[1].detail).toBe('Docs');
    expect(events[0].actorId).toBe('4');
  });

  it('names the drive when a move lands at the top of it', async () => {
    routes = [['/api/files/activity', { events: [{ id: 1, event: 'file.moved', at: '2026-07-11T09:00:00Z', meta: { from: '/Docs/a.md', to: '/a.md' } }] }]];
    const [event] = await new HttpRepository().listActivity('main://a.md');
    expect(event.kind).toBe('moved');
    expect(event.detail).toBe('main');
  });

  it('purges one trash entry by the number the trash listing gave it', async () => {
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
    const repo = new HttpRepository();
    await repo.listTrash();
    await repo.deleteForever(['main://Design']);

    const purge = calls[calls.length - 1];
    expect(purge.method).toBe('DELETE');
    expect(purge.url).toContain('/manager/trash/9');
  });

  it('empties the trash in rounds, and stops when a round purges nothing', async () => {
    let round = 0;
    routes = [['/manager/trash/empty', () => ({ purged: ++round < 3 ? 500 : 0, failed: 0, skipped: 7, more: true })]];
    await new HttpRepository().emptyTrash();
    // Three requests: two that took something, and the one that reported nothing left it may purge.
    expect(calls.filter((c) => c.url.includes('/trash/empty'))).toHaveLength(3);
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
  it('reads the sign-ins of the account and ends one by id', async () => {
    routes = [
      [
        '/api/auth/sessions',
        {
          sessions: [
            { id: 7, ip: '10.0.0.9', user_agent: 'Chrome/126.0', created_at: '2026-07-10T08:12:00Z', expires_at: '2026-08-09T08:12:00Z', current: true },
            { id: 8, created_at: '2026-07-08T19:40:00Z', expires_at: '2026-08-07T19:40:00Z', current: false },
          ],
        },
      ],
    ];
    const repo = new HttpRepository();
    const sessions = await repo.listSessions();
    // The numeric session id becomes the app's string id, and a row the server left blank stays blank.
    expect(sessions.map((s) => [s.id, s.ip ?? '', s.current])).toEqual([
      ['7', '10.0.0.9', true],
      ['8', '', false],
    ]);

    await repo.revokeSession('8');
    expect(calls.at(-1)).toMatchObject({ url: '/api/auth/sessions/8', method: 'DELETE' });
  });

  it('reads the notification switches out of the mute list and writes back what it does not own', async () => {
    let saved: unknown;
    routes = [
      [
        '/api/notifications/settings',
        (call: Call) => {
          if (call.method === 'PATCH') {
            saved = call.body;
            return {};
          }
          // `replica_fail` belongs to the admin surface, not to this modal.
          return { in_app_enabled: true, muted_events: ['comment.added', 'replica_fail'] };
        },
      ],
    ];
    const repo = new HttpRepository();
    expect(await repo.notifyPrefs()).toEqual({ shared: true, comments: false, uploads: true });

    await repo.saveNotifyPrefs({ shared: true, comments: true, uploads: false });
    expect(saved).toEqual({ in_app_enabled: true, muted_events: ['replica_fail', 'file.uploaded'] });
  });

  it('reads a node’s tags back from the server rather than from a listing row that has none', async () => {
    routes = [
      ['star/list', { nodes: [] }],
      ['manager/tags', { node_id: 2, tags: ['design', 'q3'] }],
      ['q=index', index(row({ id: 2, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))],
    ];
    const repo = new HttpRepository();
    await repo.listFolder('main://Docs');
    expect(await repo.listTags('main://Docs/notes.md')).toEqual(['design', 'q3']);
    expect(calls.at(-1)?.url).toContain('node_id=2');
  });

  it('asks for a whole phrase in quotes, and keeps the tag terms outside them', async () => {
    routes = [['/api/files/search', { results: [] }]];
    const repo = new HttpRepository();
    const query = {
      text: 'annual report', tags: [], scope: 'all', searchIn: 'everywhere', folderPath: '',
      fileType: 'any', modified: 'any', size: { preset: 'any' }, ownerId: '',
      wholePhrase: true,
    } as unknown as Parameters<HttpRepository['search']>[0];
    await repo.search(query);
    expect((calls.at(-1)?.body as { query: string }).query).toBe('"annual report"');

    await repo.search({ ...query, tags: ['design'] });
    expect((calls.at(-1)?.body as { query: string }).query).toBe('"annual report" tag:design');

    await repo.search({ ...query, wholePhrase: false });
    expect((calls.at(-1)?.body as { query: string }).query).toBe('annual report');
  });

  it('leaves a revision nobody claimed unattributed instead of signing it with the reader’s name', async () => {
    routes = [
      [
        '/api/files/versions',
        {
          versions: [
            { id: 9, node_id: 2, version_n: 2, size: 20, created_at: '2026-07-02T10:00:00Z', created_by: 4, author_name: 'Ada' },
            { id: 8, node_id: 2, version_n: 1, size: 10, created_at: '2026-07-01T10:00:00Z' },
          ],
        },
      ],
      ['star/list', { nodes: [] }],
      ['q=index', index(row({ id: 2, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))],
    ];
    const repo = new HttpRepository();
    // The numeric node id the versions endpoint needs comes from having listed the file once.
    await repo.listFolder('main://Docs');
    const versions = await repo.listVersions('main://Docs/notes.md');
    expect(versions.map((v) => [v.authorName, v.current])).toEqual([
      ['Ada', true],
      [undefined, false],
    ]);
  });

  it('lists who has access to anyone who can open the node, and says whether they may change it', async () => {
    routes = [
      [
        '/api/files/permissions',
        {
          direct: [{ id: 1, user_id: 4, user_display_name: 'Ada', level: 'owner' }],
          inherited: [{ id: 2, user_id: 5, user_email: 'mert@filex.test', level: 'viewer' }],
          can_manage: false,
        },
      ],
    ];
    const access = await new HttpRepository().listPeople('main://Docs');
    expect(access.canManage).toBe(false);
    // No display name falls back to the address, which is what the owner column already shows everybody.
    expect(access.people.map((p) => [p.name, p.role])).toEqual([
      ['Ada', 'owner'],
      ['mert@filex.test', 'viewer'],
    ]);
  });

  it('reads the caller’s own link, and removes it by the id filex actually sends', async () => {
    routes = [['/api/files/share', { shares: [{ uuid: '2', url: 'https://filex.test/s/abc' }] }]];
    const repo = new HttpRepository();
    expect(await repo.shareLink('main://Docs/notes.md')).toBe('https://filex.test/s/abc');

    await repo.removeShareLink('main://Docs/notes.md');
    // `uuid` is the share id; reading `id` here sent DELETE /share/undefined and left the link open.
    expect(calls.at(-1)).toMatchObject({ url: '/api/files/share/2', method: 'DELETE' });
  });

  it('reads a refusal to show the links as “none of yours”, because that is what the panel can act on', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403, text: async () => '{"error":"insufficient permission"}' }) as Response);
    expect(await new HttpRepository().shareLink('main://Docs/notes.md')).toBeNull();
  });

  it('sends the optional profile fields only when they were edited', async () => {
    routes = [['/api/auth/profile', { id: 3, email: 'ada@filex.test', display_name: 'Ada', full_name: 'Ada Lovelace', job_title: 'Analyst' }]];
    const repo = new HttpRepository();
    const user = await repo.updateProfile({ name: 'Ada', jobTitle: '' });
    // An empty string is an edit — it is how a job title is cleared — while an absent field is not sent at all.
    expect(calls.at(-1)?.body).toEqual({ display_name: 'Ada', job_title: '' });
    expect([user.fullName, user.jobTitle]).toEqual(['Ada Lovelace', 'Analyst']);
  });
  it('reports the assistant from the server, and reads an older server’s silence as “no assistant”', async () => {
    routes = [
      ['/api/files/capabilities', { upload: true, search: true }],
      ['/api/assistant/status', { enabled: true, model: 'a-model' }],
    ];
    expect((await new HttpRepository().capabilities()).assistant).toBe(true);

    // No such route (an older filex) — the panel is simply not offered, rather than the whole snapshot failing.
    routes = [['/api/files/capabilities', { upload: true }]];
    expect((await new HttpRepository().capabilities()).assistant).toBe(false);
  });

  it('streams one turn, reassembling events that arrive split across chunks', async () => {
    const chunks = [
      'data: {"type":"meta","conversation_id":"7"}\n\ndata: {"type":"te',
      'xt","delta":"Your "}\n\ndata: {"type":"text","delta":"files."}\n\n',
      'data: {"type":"done"}\n\n',
    ];
    let asked: { url: string; body: unknown } | null = null;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      asked = { url, body: JSON.parse(String(init?.body)) };
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
      } as Response;
    });

    const events = [];
    for await (const event of new HttpRepository().assistantAsk('how are my files?', 'filename', '7', new AbortController().signal)) {
      events.push(event);
    }
    // The chip travels with the question: the server turns it into a scope hint for this turn.
    expect(asked).toMatchObject({ url: '/api/assistant/sessions/7/turn', body: { prompt: 'how are my files?', mode: 'filename' } });
    expect(events).toEqual([
      { type: 'meta', conversationId: '7' },
      { type: 'text', delta: 'Your ' },
      { type: 'text', delta: 'files.' },
      { type: 'done' },
    ]);
  });

  it('turns the rows a search found into result cards', async () => {
    const frames = [
      'data: {"type":"meta","conversation_id":"7"}\n\n',
      'data: {"type":"hits","hits":[{"path":"main://Docs/spec.pdf","name":"spec.pdf","type":"file","size":12,"last_modified":1788800115455,"snippet":"the «invoice» for March"}]}\n\n',
      'data: {"type":"done"}\n\n',
    ];
    vi.stubGlobal('fetch', async () => {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }),
      } as Response;
    });
    const events = [];
    for await (const event of new HttpRepository().assistantAsk('find the invoice', 'filename', '7', new AbortController().signal)) {
      events.push(event);
    }
    const hits = events.find((e) => e.type === 'hits');
    expect(hits).toBeDefined();
    const hit = (hits as { hits: SearchHit[] }).hits[0];
    expect(hit.node).toMatchObject({ id: 'main://Docs/spec.pdf', name: 'spec.pdf', kind: 'file', size: 12 });
    expect(hit.storageId).toBe('main');
    expect(hit.folderPath).toBe('Docs');
    // ⚠ The « » markers become highlight ranges; they are not shown as characters.
    expect(hit.snippet).toEqual({ text: 'the invoice for March', ranges: [{ start: 4, end: 11 }] });
  });

  it('passes the name the server gave the conversation', async () => {
    const frames = [
      'data: {"type":"meta","conversation_id":"7"}\n\n',
      'data: {"type":"text","delta":"Four."}\n\n',
      'data: {"type":"title","title":"Counting the files"}\n\n',
      'data: {"type":"done"}\n\n',
    ];
    vi.stubGlobal('fetch', async () => {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }),
      } as Response;
    });
    const events = [];
    for await (const event of new HttpRepository().assistantAsk('how many files?', 'filename', '7', new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: 'title', title: 'Counting the files' });
  });

  it('raises the server’s refusal instead of opening an empty stream', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, text: async () => '{"error":"assistant: a turn is already running"}' }) as Response);
    const turn = new HttpRepository().assistantAsk('again', 'filename', '7', new AbortController().signal);
    await expect((async () => { for await (const _ of turn); })()).rejects.toThrow('already running');
  });

  it('refuses a turn with no conversation to store it in', async () => {
    const turn = new HttpRepository().assistantAsk('hi', 'filename', null, new AbortController().signal);
    await expect((async () => { for await (const _ of turn); })()).rejects.toThrow('conversation');
  });
  it('passes through what the assistant is doing and what it needs permission for', async () => {
    const frames = [
      'data: {"type":"meta","conversation_id":"7"}\n\n',
      'data: {"type":"tool","tool":"read_file","target":"main://Docs/pay.csv"}\n\n',
      'data: {"type":"card","kind":"approval","path":"main://Docs/pay.csv","reason":"to total the salaries"}\n\n',
      'data: {"type":"done"}\n\n',
    ];
    vi.stubGlobal('fetch', async () => {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }),
      } as Response;
    });
    const events = [];
    for await (const event of new HttpRepository().assistantAsk('summarise pay', 'filename', '7', new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'meta', conversationId: '7' },
      { type: 'tool', tool: 'read_file', target: 'main://Docs/pay.csv' },
      { type: 'card', card: { kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' } },
      { type: 'done' },
    ]);
  });

  it('reads a stored conversation with its questions and the permissions already given', async () => {
    routes = [
      [
        '/api/assistant/sessions/7',
        {
          messages: [
            { id: '1', role: 'user', content: 'summarise pay', aborted: false, secret_notice: false, created_at: '2026-07-01T10:00:00Z' },
            {
              id: '2',
              role: 'assistant',
              content: 'I need the pay file.',
              aborted: false,
              secret_notice: false,
              created_at: '2026-07-01T10:00:01Z',
              cards: [{ kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' }],
            },
          ],
          granted: ['main://Docs/pay.csv'],
        },
      ],
    ];
    const conversation = await new HttpRepository().assistantMessages('7');
    expect(conversation.granted).toEqual(['main://Docs/pay.csv']);
    expect(conversation.messages[1].cards).toEqual([{ kind: 'approval', path: 'main://Docs/pay.csv', reason: 'to total the salaries' }]);
  });

  it('grants permission for one path, in the shape the server takes', async () => {
    routes = [['/approvals', { ok: true }]];
    await new HttpRepository().approveAssistantRead('7', 'main://Docs/pay.csv');
    expect(calls.at(-1)).toMatchObject({
      url: '/api/assistant/sessions/7/approvals',
      method: 'POST',
      body: { path: 'main://Docs/pay.csv' },
    });
  });
  it('reads a plan card as the server currently holds it, not as the message froze it', async () => {
    routes = [
      [
        '/api/assistant/sessions/7',
        {
          messages: [
            {
              id: '2',
              role: 'assistant',
              content: 'Proposed.',
              aborted: false,
              secret_notice: false,
              created_at: '2026-07-01T10:00:01Z',
              cards: [
                {
                  kind: 'plan',
                  plan_id: '3',
                  plan_kind: 'tags',
                  summary: 'Tag the invoices',
                  status: 'done',
                  items: [{ path: 'main://Docs/a.pdf', action: 'tag as invoices' }],
                  results: [{ path: 'main://Docs/a.pdf', state: 'skipped', code: 'changed', reason: 'the file changed after the plan was made' }],
                },
              ],
            },
          ],
          granted: [],
        },
      ],
    ];
    const conversation = await new HttpRepository().assistantMessages('7');
    expect(conversation.messages[0].cards).toEqual([
      {
        kind: 'plan',
        id: '3',
        planKind: 'tags',
        summary: 'Tag the invoices',
        status: 'done',
        items: [{ path: 'main://Docs/a.pdf', action: 'tag as invoices' }],
        results: [{ path: 'main://Docs/a.pdf', state: 'skipped', code: 'changed', reason: 'the file changed after the plan was made' }],
      },
    ]);
  });

  it('approves a plan with an empty body: the work is the plan the server already holds', async () => {
    routes = [['/plans/3/approve', { ok: true, status: 'done', items: [{ path: 'main://Docs/a.pdf', state: 'done' }], done: 1, skipped: 0, failed: 0 }]];
    const outcome = await new HttpRepository().decideAssistantPlan('7', '3', true);
    expect(calls.at(-1)).toMatchObject({ url: '/api/assistant/sessions/7/plans/3/approve', method: 'POST', body: {} });
    expect(outcome).toEqual({ status: 'done', results: [{ path: 'main://Docs/a.pdf', state: 'done' }], done: 1, skipped: 0, failed: 0 });

    routes = [['/plans/3/cancel', { ok: true, status: 'cancelled' }]];
    const refused = await new HttpRepository().decideAssistantPlan('7', '3', false);
    expect(calls.at(-1)?.url).toBe('/api/assistant/sessions/7/plans/3/cancel');
    expect(refused.status).toBe('cancelled');
  });
});
