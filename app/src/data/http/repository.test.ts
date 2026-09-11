import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from './client';
import { HttpRepository } from './repository';
import type { WireFileNode } from './map';
import type { UploadRateLimited } from '../repository';
import { noQuota, ROLE_PERMISSIONS, type AssistantReport, type SearchHit } from '../types';
import { emptyFilter } from '@/features/files/filters';
import { emptyQuery } from '@/features/search/searchStore';

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

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

/*
 * The sign-in screen asks which realms exist before anybody is signed in, and filex refuses a visitor. Reported as
 * a lost session, that 401 raised the "your session has ended" prompt on the form itself — and the person then met
 * it on the first screen after signing in, with nothing in the network log to explain it.
 */
it('does not report the sign-in screen’s own 401 as a lost session', async () => {
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }) as Response);
  const lost = vi.fn();
  setUnauthorizedHandler(lost);
  await expect(new HttpRepository().authOptions()).rejects.toMatchObject({ status: 401 });
  expect(lost).not.toHaveBeenCalled();
});

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
        { storages: [{ id: 1, name: 'main', read_only: false, used_bytes: 200 }, { id: 2, name: 'archive', read_only: true, used_bytes: 50 }] },
      ],
      ['/api/files/quota/me', { used_bytes: 250, quota_bytes: 1000 }],
    ];
    const storages = await new HttpRepository().listStorages();
    // The account's own 250 is the sum, not each drive's figure — which is what every card used to show.
    expect(storages).toEqual([
      { id: 'main', serverId: 1, name: 'main', rootId: 'main://', quota: { ...noQuota(), usedBytes: 200, totalBytes: 1000 }, shared: false, viaGroups: [] },
      { id: 'archive', serverId: 2, name: 'archive', rootId: 'archive://', quota: { ...noQuota(), usedBytes: 50, totalBytes: 1000 }, shared: false, viaGroups: [] },
    ]);
  });

  it('addresses a listing by path and folds in the starred flag the listing cannot report', async () => {
    routes = [
      ['star/list', { nodes: [{ id: 2, storage_id: 1, name: 'report.pdf', path: '/Docs/report.pdf', type: 'file', size: 5, storage: 'main' }] }],
      ['q=index', index(row({ id: 3, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }), row({ id: 2, path: 'main://Docs/report.pdf', basename: 'report.pdf', type: 'file' }))],
    ];
    const { nodes: files } = await new HttpRepository().listFolder('main://Docs');
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

  it('creates an empty file under the parent address and answers with the row the server now lists', async () => {
    routes = [['q=index', index(row({ id: 9, path: 'main://Docs/Untitled.txt', basename: 'Untitled.txt', type: 'file', size: 0 }))], ['q=newfile', { ok: true }]];
    const created = await new HttpRepository().createFile('main://Docs', 'Untitled.txt');
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/files/manager?q=newfile', body: { path: 'main://Docs', name: 'Untitled.txt' } });
    expect(created).toMatchObject({ id: 'main://Docs/Untitled.txt', name: 'Untitled.txt', kind: 'file' });
  });

  it('reports a taken file name as the shared duplicate error too', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, text: async () => '{"error":"exists"}' }) as Response);
    await expect(new HttpRepository().createFile('main://Docs', 'Untitled.txt')).rejects.toThrow('duplicateName');
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

  it('maps a second-factor enrolment into the app’s spelling', async () => {
    routes = [['/api/auth/totp/enroll', { secret: 'JBSWY3DP', otpauth_url: 'otpauth://totp/filex:ada?secret=JBSWY3DP', qr_svg: '<svg></svg>', recovery_codes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] }]];
    const enrollment = await new HttpRepository().totpEnroll();
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/auth/totp/enroll' });
    expect(enrollment).toEqual({ secret: 'JBSWY3DP', otpauthUrl: 'otpauth://totp/filex:ada?secret=JBSWY3DP', qrSvg: '<svg></svg>', recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] });
  });

  it('reads a refused verification code as the code being wrong, not as a lost session', async () => {
    const lost = vi.fn();
    setUnauthorizedHandler(lost);
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid code"}' }) as Response);
    await expect(new HttpRepository().totpVerify('000000')).rejects.toThrow('invalidCode');
    expect(lost).not.toHaveBeenCalled();
    // No enrolment to confirm is a different failure, and keeps the server's words.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, text: async () => '{"error":"no pending TOTP enrollment"}' }) as Response);
    await expect(new HttpRepository().totpVerify('000000')).rejects.toThrow('no pending TOTP enrollment');
  });

  it('tells the wrong password apart from the wrong code when switching the second factor off', async () => {
    routes = [['/api/auth/totp/disable', { ok: true, totp_enabled: false }]];
    await new HttpRepository().totpDisable('right', 'AAAAA-BBBBB');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { password: 'right', code: 'AAAAA-BBBBB' } });
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '{"error":"password incorrect"}' }) as Response);
    await expect(new HttpRepository().totpDisable('nope', '123456')).rejects.toThrow('wrongPassword');
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid code"}' }) as Response);
    await expect(new HttpRepository().totpDisable('right', '000000')).rejects.toThrow('invalidCode');
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
      drive: null,
      folderPath: 'Docs/2026',
      modified: 'week',
      around: null,
      fileType: 'documents',
      tags: [],
      ownerId: '4',
      size: { preset: 'medium', min: null, max: null, unit: 'MB' },
      path: '',
      pathMode: 'only',
      excludePaths: [],
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
    const { nodes: listed } = await repo.listFolder('main://');

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

  // A poll that never arrived says nothing about the JOB. Reading one as a failed move is what had people repeat
  // a move that had in fact succeeded, and end up with the subtree in the destination twice.
  it('asks again when a poll does not arrive, and fails a move only on the server’s own verdict', async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      routes = [
        [
          '/api/files/ops/7',
          () => {
            if (++asked === 1) throw new TypeError('Failed to fetch');
            return { id: 7, kind: 'move', status: 'ok' };
          },
        ],
        ['/api/files/move', { op: { id: 7, kind: 'move', status: 'pending' } }],
      ];
      const moved = new HttpRepository().move(['main://Docs/a.txt'], 'main://Reports');
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(moved).resolves.toBeUndefined();
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once the caller has given up, and reports the job as still the server’s', async () => {
    vi.useFakeTimers();
    try {
      routes = [
        ['/api/files/ops/8', { id: 8, kind: 'move', status: 'running' }],
        ['/api/files/move', { op: { id: 8, kind: 'move', status: 'running' } }],
      ];
      const controller = new AbortController();
      const pending = new HttpRepository().move(['main://a.txt'], 'main://b', controller.signal);
      const settled = expect(pending).rejects.toThrow('operationPending');
      await vi.advanceTimersByTimeAsync(1_000);
      const polls = calls.filter((c) => c.url.includes('/ops/8')).length;
      expect(polls).toBeGreaterThan(0);

      controller.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      // The page is gone; the requests went with it instead of running on for the rest of the minute.
      expect(calls.filter((c) => c.url.includes('/ops/8'))).toHaveLength(polls);
    } finally {
      vi.useRealTimers();
    }
  });

  // The staged bytes and their quota reservation live until the collector takes them, so "there is nothing to
  // resume" is the server's answer to give. Treating an offline start as that answer wiped every resumable record.
  it('reads a session as gone only when the server says so, and passes any other failure on', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, text: async () => '{"error":"no such session"}' }) as unknown as Response);
    await expect(new HttpRepository().uploadSession('u8')).resolves.toBeNull();

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 410, text: async () => '' }) as unknown as Response);
    await expect(new HttpRepository().uploadSession('u9')).resolves.toBeNull();

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new HttpRepository().uploadSession('u10')).rejects.toThrow('Failed to fetch');

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => '' }) as unknown as Response);
    await expect(new HttpRepository().uploadSession('u11')).rejects.toThrow('HTTP 500');
  });

  // The list carries what each drive HOLDS, and it used to be read once for the whole session: the quota bar in
  // the sidebar and on the drive cards never moved again, whatever was uploaded, deleted or purged.
  it('reads the drive list again after something changed what a drive holds', async () => {
    let reads = 0;
    routes = [
      ['/api/files/storages', () => ({ storages: [{ name: 'main', read_only: false, used_bytes: reads++ === 0 ? 200 : 40 }] })],
      ['/api/files/quota/me', { used_bytes: 250, quota_bytes: 1000 }],
      ['/manager/trash/empty', { purged: 3, failed: 0, skipped: 0, more: false }],
    ];
    const repo = new HttpRepository();
    expect((await repo.listStorages())[0].quota.usedBytes).toBe(200);
    // Still cached while nothing has changed: the second read costs no request.
    expect((await repo.listStorages())[0].quota.usedBytes).toBe(200);
    expect(reads).toBe(1);

    await repo.emptyTrash();
    expect((await repo.listStorages())[0].quota.usedBytes).toBe(40);
  });

  it('forgets the numbers of everything under a folder it moved, not just the folder', async () => {
    routes = [
      [
        'q=index',
        index(row({ id: 5, path: 'main://Docs', basename: 'Docs' }), row({ id: 6, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' })),
      ],
      ['/star/list', { nodes: [] }],
      ['/api/files/move', { op: { id: 9, kind: 'move', status: 'ok' } }],
      ['/manager/star', { ok: true }],
    ];
    const repo = new HttpRepository();
    await repo.listFolder('main://Docs');
    await repo.move(['main://Docs'], 'main://Archive');

    // The child answers to another address now. Its old one used to keep number 6, so starring "main://Docs/notes.md"
    // silently starred whatever had moved in there since.
    await expect(repo.setStarred(['main://Docs/notes.md'], true)).rejects.toThrow('no node id known');
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

  // The download used to be built as "the preview address plus ?download=1", which put a SECOND question mark
  // inside the query — the server then read `?download=1` as part of the node's path, found no such node, and the
  // browser cancelled the save. Serving a download is the manager's own verb, and only the data layer knows that.
  it('serves a download through the manager verb for it, as one well-formed URL', () => {
    const url = new HttpRepository().downloadUrl('live://Docs/a b.txt')!;
    expect(url).toBe('/api/files/manager?q=download&path=live%3A%2F%2FDocs%2Fa%20b.txt');
    expect(url.split('?')).toHaveLength(2);
    expect(new URLSearchParams(url.split('?')[1]).get('path')).toBe('live://Docs/a b.txt');
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
    expect(repo.previewUrl('main://Photos/a b.webp')).toBe('/api/files/manager?q=preview&path=main%3A%2F%2FPhotos%2Fa%20b.webp');
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

  // ⚠ The session id is the only thing that can bring a transfer back after a reload: `begin` always opens a NEW
  // session at offset 0, so an id nobody wrote down is staged bytes nobody can continue.
  it('hands the session id to the caller before any byte moves', async () => {
    routes = [
      ['/upload/begin', { id: 'u3', chunk_size: 16, offset: 0 }],
      ['/upload/u3/commit', { op_id: 13 }],
      ['/upload/u3', { offset: 3 }],
      ['/api/files/ops/13', { id: 13, kind: 'upload-commit', status: 'ok' }],
      ['/star/list', { nodes: [] }],
      ['q=index', index(row({ id: 6, path: 'main://Docs/a.txt', basename: 'a.txt', type: 'file', size: 3 }))],
    ];
    const order: string[] = [];
    await new HttpRepository().uploadFile(
      'main://Docs',
      { name: 'a.txt', size: 3, blob: new Blob(['abc']) },
      { onSession: (id) => order.push(`session:${id}`), onProgress: (sent) => order.push(`sent:${sent}`) },
    );
    expect(order[0]).toBe('session:u3');
  });

  it('resumes a staged upload from the offset the server reports, not from the start', async () => {
    routes = [
      ['/upload/u4/commit', { op_id: 14 }],
      // Asked first for the offset, then sent the rest.
      ['/upload/u4', (call: Call) =>
        call.method === 'PUT'
          ? { offset: Number(/bytes \d+-(\d+)\//.exec(String(call.headers?.['content-range']))![1]) + 1 }
          : { offset: 8, total_size: 10, chunk_size: 4, state: 'staging' }],
      ['/api/files/ops/14', { id: 14, kind: 'upload-commit', status: 'ok' }],
      ['/star/list', { nodes: [] }],
      ['q=index', index(row({ id: 7, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file', size: 10 }))],
    ];
    const seen: number[] = [];
    await new HttpRepository().resumeUpload(
      'u4',
      'main://Docs',
      { name: 'notes.md', size: 10, blob: new Blob(['0123456789']) },
      { onProgress: (sent) => seen.push(sent) },
    );
    const puts = calls.filter((c) => c.method === 'PUT');
    // Only the tail: the first 8 bytes are already the server's.
    expect(puts.map((c) => c.headers?.['content-range'])).toEqual(['bytes 8-9/10']);
    expect(seen).toEqual([8, 10]);
    expect(calls.some((c) => c.url.includes('/upload/begin'))).toBe(false);
  });

  it('reads a session back, and reports one the server has finished with as gone', async () => {
    routes = [['/upload/u5', { offset: 4, total_size: 10, state: 'staging' }]];
    await expect(new HttpRepository().uploadSession('u5')).resolves.toEqual({ id: 'u5', offset: 4, size: 10 });

    routes = [['/upload/u6', { offset: 10, total_size: 10, state: 'committed' }]];
    // Committed, expired or unknown are one answer to the caller: there is nothing here to carry on.
    await expect(new HttpRepository().uploadSession('u6')).resolves.toBeNull();
  });

  it('aborts a staged upload so the staging area and the quota reservation go with it', async () => {
    routes = [['/upload/u7', {}]];
    await new HttpRepository().abortUpload('u7');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('/upload/u7') });
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

  // ── a target the server refuses ────────────────────────────────────────────
  //
  // Whether a name is taken is the server's answer now: `if_exists: 'fail'` makes `begin` — and `commit`, for a
  // file that appeared meanwhile — refuse with a 409 whose `code` says which refusal it is. The store needs the
  // phase to know whether the bytes are already staged, and the session id to finish or drop that session.

  /** A fetch that refuses one URL with a 409 body and answers the rest from `routes`. */
  function refusing(pattern: string, method: string, body: unknown) {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const raw = init?.body;
      const parsed = raw instanceof Blob ? { bytes: raw.size } : raw ? JSON.parse(String(raw)) : undefined;
      const call: Call = { url, method: init?.method ?? 'GET', body: parsed, headers: init?.headers as Record<string, string> | undefined };
      calls.push(call);
      if (url.includes(pattern) && call.method === method) return { ok: false, status: 409, text: async () => JSON.stringify(body) } as Response;
      return { ok: true, status: 200, text: async () => JSON.stringify(answer(call)) } as Response;
    });
  }

  it('reports a taken name at begin as a conflict with no session, and sends the rule it was given', async () => {
    refusing('/upload/begin', 'POST', { error: 'a file with this name already exists', code: 'EXISTS' });
    await expect(
      new HttpRepository().uploadFile('main://Docs', { name: 'a.txt', size: 3, blob: new Blob(['abc']) }, { ifExists: 'fail' }),
    ).rejects.toMatchObject({ name: 'UploadConflict', reason: 'exists', phase: 'begin', sessionId: null });
    expect(calls[0].body).toMatchObject({ if_exists: 'fail' });
    expect(calls).toHaveLength(1);
  });

  it('reports a name taken by commit time as a conflict carrying the session, with the bytes already staged', async () => {
    routes = [
      ['/upload/begin', { id: 'u20', chunk_size: 16, offset: 0 }],
      ['/upload/u20', { offset: 3 }],
    ];
    refusing('/upload/u20/commit', 'POST', { error: 'a file with this name already exists', code: 'EXISTS' });
    await expect(
      new HttpRepository().uploadFile('main://Docs', { name: 'a.txt', size: 3, blob: new Blob(['abc']) }, { ifExists: 'fail' }),
    ).rejects.toMatchObject({ reason: 'exists', phase: 'commit', sessionId: 'u20' });
    const commit = calls.find((c) => c.url.includes('/upload/u20/commit'))!;
    expect(commit.body).toEqual({ if_exists: 'fail' });
  });

  it('finishes a refused session with commitUpload, sending no byte again', async () => {
    routes = [
      ['/upload/u21/commit', { op_id: 21 }],
      ['/api/files/ops/21', { id: 21, kind: 'upload-commit', status: 'ok' }],
      ['/star/list', { nodes: [] }],
      ['q=index', index(row({ id: 9, path: 'main://Docs/a.txt', basename: 'a.txt', type: 'file', size: 3 }))],
    ];
    const node = await new HttpRepository().commitUpload('u21', 'main://Docs', 'a.txt', { ifExists: 'replace' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: expect.stringContaining('/upload/u21/commit'), body: { if_exists: 'replace' } });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(node).toMatchObject({ id: 'main://Docs/a.txt' });
  });

  it('tells a target somebody else is uploading to apart from a taken name', async () => {
    refusing('/upload/begin', 'POST', { error: 'this file is being uploaded right now', code: 'UPLOAD_IN_PROGRESS' });
    await expect(
      new HttpRepository().uploadFile('main://Docs', { name: 'a.txt', size: 3, blob: new Blob(['abc']) }, { ifExists: 'replace' }),
    ).rejects.toMatchObject({ reason: 'inProgress', phase: 'begin' });
    // Any other 409 is not about the target and reaches the caller as the server stated it.
    refusing('/upload/begin', 'POST', { error: 'session is not staging' });
    await expect(
      new HttpRepository().uploadFile('main://Docs', { name: 'a.txt', size: 3, blob: new Blob(['abc']) }),
    ).rejects.toThrow('session is not staging');
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
      text: 'annual report', tags: [], scope: 'all', searchIn: 'everywhere', drive: null, folderPath: '', path: '', around: null,
      pathMode: 'only', excludePaths: [],
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
    expect(versions.map((v) => v.authorName)).toEqual(['Ada', undefined]);
  });

  // filex snapshots a file's bytes BEFORE overwriting them, so the newest row here is what the file was before its
  // last save and the live file has no row at all. Marking row zero "current" labelled the previous contents as
  // the present ones AND hid Restore on the one revision a rollback actually wants.
  it('marks no revision as the live file, because none of them is', async () => {
    routes = [
      [
        '/api/files/versions',
        { versions: [{ id: 9, node_id: 2, version_n: 2, size: 20, created_at: '2026-07-02T10:00:00Z' }, { id: 8, node_id: 2, version_n: 1, size: 10, created_at: '2026-07-01T10:00:00Z' }] },
      ],
      ['star/list', { nodes: [] }],
      ['q=index', index(row({ id: 2, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))],
    ];
    const repo = new HttpRepository();
    await repo.listFolder('main://Docs');
    const versions = await repo.listVersions('main://Docs/notes.md');
    expect(versions.every((v) => !('current' in v))).toBe(true);
  });

  // A rollback has to be undoable, so the live bytes are snapshotted before the older ones land on them.
  it('asks the server to keep the live bytes before it overwrites them', async () => {
    routes = [
      ['/api/files/versions/restore', { ok: true }],
      ['star/list', { nodes: [] }],
      ['q=index', index(row({ id: 2, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))],
    ];
    const repo = new HttpRepository();
    await repo.listFolder('main://Docs');
    await repo.restoreVersion('main://Docs/notes.md', '8');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { node_id: 2, version_id: 8, snapshot_current: true } });
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

  it('reads branding, and drops the two fields the public pages own', async () => {
    routes = [['/api/branding', { name: 'Acme Drive', logo_url: '/brand.svg', accent: '#c0392b', footer_text: 'Acme Inc.', hide_powered_by: true }]];
    expect(await new HttpRepository().branding()).toEqual({ name: 'Acme Drive', logoUrl: '/brand.svg', accent: '#c0392b' });
  });

  it('reads an unbranded install as empty rather than undefined', async () => {
    routes = [['/api/branding', {}]];
    expect(await new HttpRepository().branding()).toEqual({ name: '', logoUrl: '', accent: '' });
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

  /*
   * The role permissions gate every menu in the app, so the one answer that must NOT be read as "nothing" is an
   * older server's silence: it has no such rule to state, and reading its absence as a refusal would empty every
   * menu the moment the app ships ahead of the backend.
   */
  it('reads the caller’s role permissions, and an older server’s silence as all of them', async () => {
    routes = [
      ['/api/files/capabilities', { upload: true, permissions: ['files.upload', 'files.download', 'not.a.permission'] }],
      ['/api/assistant/status', { enabled: false }],
    ];
    const allowed = (await new HttpRepository().capabilities()).allowed;
    // An id this build has no surface for is dropped rather than carried around as a string nothing can ask about.
    expect([...allowed].sort()).toEqual(['files.download', 'files.upload']);
    expect(allowed.has('files.delete')).toBe(false);

    routes = [['/api/files/capabilities', { upload: true }]];
    const older = (await new HttpRepository().capabilities()).allowed;
    expect([...older].sort()).toEqual([...ROLE_PERMISSIONS].sort());
  });

  // 413 and 429 both say "not this upload", and each carries the figure the row has to print: the ceiling that was
  // met, or how long the window still has to run.
  it('reads the two quota refusals of an upload, and takes the wait from the header when the body has none', async () => {
    const refuse = (status: number, body: unknown, headers?: Record<string, string>) =>
      vi.stubGlobal('fetch', async () => ({ ok: false, status, headers: new Headers(headers ?? {}), text: async () => JSON.stringify(body) }) as Response);
    const upload = () => new HttpRepository().uploadFile('main://Docs', { name: 'a.txt', size: 3, blob: new Blob(['abc']) });

    refuse(413, { error: 'file limit reached', code: 'FILE_LIMIT_EXCEEDED', limit: 5000, used: 5000 });
    await expect(upload()).rejects.toMatchObject({ name: 'FileLimitExceeded', limit: 5000, used: 5000 });

    refuse(429, { error: 'too many uploads', code: 'UPLOAD_RATE_LIMITED', retry_after_seconds: 720 });
    await expect(upload()).rejects.toMatchObject({ name: 'UploadRateLimited', retryAfterSeconds: 720 });

    // A proxy that answers before filex does sends the header and no body field; the row still has a number to say.
    refuse(429, { error: 'too many uploads', code: 'UPLOAD_RATE_LIMITED' }, { 'retry-after': '90' });
    await expect(upload()).rejects.toMatchObject({ name: 'UploadRateLimited', retryAfterSeconds: 90 });

    // And a proxy that sends NEITHER. `Number(null)` is 0, which is finite, so this used to decode as "wait no
    // time at all" and the row re-sent into the refusal it had just met, as fast as the network allowed.
    refuse(429, { error: 'too many uploads', code: 'UPLOAD_RATE_LIMITED' });
    const noWait = (await upload().catch((e: unknown) => e)) as UploadRateLimited;
    expect(noWait).toMatchObject({ name: 'UploadRateLimited' });
    expect(noWait.retryAfterSeconds).toBeGreaterThan(0);
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
    const context = { page: 'folder' as const, folder: 'main://Docs', selected: ['main://Docs/a.pdf'] };
    for await (const event of new HttpRepository().assistantAsk('how are my files?', 'filename', '7', new AbortController().signal, context)) {
      events.push(event);
    }
    // The chip and the screen travel with the question: the server turns both into hints for this turn.
    expect(asked).toMatchObject({ url: '/api/assistant/sessions/7/turn', body: { prompt: 'how are my files?', mode: 'filename', context } });
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

  it('turns a report a tool wrote into a downloadable card with search-result rows', async () => {
    const frames = [
      'data: {"type":"meta","conversation_id":"7"}\n\n',
      'data: {"type":"report","report":{"title":"Q1 files","text":"All of them.","rows":[{"path":"main://Docs/spec.pdf","name":"spec.pdf","type":"file","size":12,"last_modified":1788800115455}]}}\n\n',
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
    for await (const event of new HttpRepository().assistantAsk('list the quarter', 'filename', '7', new AbortController().signal)) {
      events.push(event);
    }
    const report = events.find((e) => e.type === 'report');
    expect(report).toBeDefined();
    const { report: card } = report as { report: AssistantReport };
    expect(card.title).toBe('Q1 files');
    expect(card.text).toBe('All of them.');
    expect(card.rows[0].node).toMatchObject({ id: 'main://Docs/spec.pdf', name: 'spec.pdf', kind: 'file', size: 12 });
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

  it('answers a read request for one path, in the shape the server takes', async () => {
    routes = [['/approvals', { ok: true }]];
    await new HttpRepository().decideAssistantRead('7', 'main://Docs/pay.csv', true);
    expect(calls.at(-1)).toMatchObject({
      url: '/api/assistant/sessions/7/approvals',
      method: 'POST',
      body: { path: 'main://Docs/pay.csv', decision: 'allow' },
    });
    await new HttpRepository().decideAssistantRead('7', 'main://Docs/pay.csv', false);
    expect(calls.at(-1)).toMatchObject({ body: { path: 'main://Docs/pay.csv', decision: 'deny' } });
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

  // ── the filter chips ────────────────────────────────────────────────────────
  //
  // Every one of these listings is capped. What matters is that the chip
  // reaches the SERVER: a chip applied to the page instead answers with the
  // matches among the newest N rows, and looks exactly like an empty result.

  it('sends the chips to the capped listings instead of sieving what comes back', async () => {
    routes = [
      ['/star/list', { nodes: [] }],
      ['/manager/recent', { nodes: [] }],
      ['/manager/trash', { entries: [] }],
    ];
    const repo = new HttpRepository();
    const filter = { fileType: 'documents', modified: 'any', size: 'large', personId: '7', name: '', tags: [] as string[], around: null } as const;

    await repo.listStarred(filter);
    calls.length = 0; // Recent marks its rows starred, which asks star/list again — without the chips, and rightly so.
    await repo.listRecent(filter);
    const recent = calls[0].url;
    await repo.listTrash(filter);

    for (const url of [recent, calls.at(-1)!.url]) {
      const query = new URLSearchParams(url.split('?')[1]);
      expect(query.get('ext')).toBe('md,pdf');
      expect(query.get('size_min')).toBe(String(100 * 1024 * 1024));
      expect(query.get('size_max')).toBeNull();
      expect(query.get('owner_id')).toBe('7');
      expect(query.get('modified_after')).toBeNull();
    }
  });

  it('sends the date window as two edges, on the column the window names', async () => {
    routes = [['/star/list', { nodes: [] }]];
    const repo = new HttpRepository();
    const at = '2026-09-09T12:00:00Z';
    const day = 24 * 60 * 60 * 1000;

    await repo.listStarred({ ...emptyFilter(), around: { field: 'modified', at, span: 'day' } });
    let query = new URLSearchParams(calls[0].url.split('?')[1]);
    expect(query.get('modified_after')).toBe(String(Date.parse(at) - day));
    expect(query.get('modified_before')).toBe(String(Date.parse(at) + day));
    expect(query.get('created_after')).toBeNull();

    calls.length = 0;
    await repo.listStarred({ ...emptyFilter(), around: { field: 'created', at, span: 'day' } });
    query = new URLSearchParams(calls[0].url.split('?')[1]);
    expect(query.get('created_after')).toBe(String(Date.parse(at) - day));
    expect(query.get('created_before')).toBe(String(Date.parse(at) + day));
    expect(query.get('modified_after')).toBeNull();
  });

  it('spans the window by what the chip was set to, either side of the moment', async () => {
    routes = [['/star/list', { nodes: [] }]];
    const at = '2026-09-09T12:00:00Z';
    await new HttpRepository().listStarred({ ...emptyFilter(), around: { field: 'modified', at, span: 'week' } });
    const query = new URLSearchParams(calls[0].url.split('?')[1]);
    expect(query.get('modified_after')).toBe(String(Date.parse(at) - 7 * 24 * 60 * 60 * 1000));
    expect(query.get('modified_before')).toBe(String(Date.parse(at) + 7 * 24 * 60 * 60 * 1000));
  });

  it('sends the search’s date window as two edges, on the column it names', async () => {
    const at = '2026-09-09T12:00:00Z';
    const day = 24 * 60 * 60 * 1000;
    routes = [['/files/search', { results: [] }]];
    await new HttpRepository().search({ ...emptyQuery(), text: 'rapor', around: { field: 'created', at, span: 'day' } });
    const body = calls.at(-1)!.body as Record<string, unknown>;
    expect(body).toMatchObject({ created_after: Date.parse(at) - day, created_before: Date.parse(at) + day });
    expect(body.modified_after).toBeUndefined();
  });

  it('reads the drive’s whole tag vocabulary for the tag chip’s menu', async () => {
    routes = [['manager/tags/all', { tags: ['archive', 'design'] }]];
    expect(await new HttpRepository().listAllTags()).toEqual(['archive', 'design']);
  });

  it('sends the tags the panel set, comma-joined the way the extensions travel', async () => {
    routes = [['/star/list', { nodes: [] }]];
    await new HttpRepository().listStarred({ ...emptyFilter(), tags: ['design', 'q3'] });
    expect(new URLSearchParams(calls[0].url.split('?')[1]).get('tag')).toBe('design,q3');
  });

  it('turns the Modified chip into a moment, not a number of days', async () => {
    vi.setSystemTime(Date.parse('2026-09-09T00:00:00Z'));
    routes = [['/star/list', { nodes: [] }]];
    await new HttpRepository().listStarred({ fileType: 'any', modified: 'week', size: 'any', personId: null, name: '', tags: [], around: null });

    const query = new URLSearchParams(calls[0].url.split('?')[1]);
    expect(query.get('modified_after')).toBe(String(Date.parse('2026-09-02T00:00:00Z')));
    expect(query.get('ext')).toBeNull();
    vi.useRealTimers();
  });

  it('asks an unfiltered listing for nothing but its page', async () => {
    routes = [['/manager/recent', { nodes: [] }], ['/star/list', { nodes: [] }]];
    await new HttpRepository().listRecent();
    expect(calls[0].url).toBe('/api/files/manager/recent?limit=200');
  });

  // The panel prints "N of M conversations". M is the server's number and rides along with the list it applies to;
  // the client used to keep a constant of its own, which is only right until an install changes the limit.
  it('takes the conversation ceiling from the listing that reports it', async () => {
    routes = [['/api/assistant/sessions', { sessions: [], max: 25 }]];
    const repo = new HttpRepository();
    // What filex ships with, until a listing says otherwise.
    expect(repo.assistantSessionMax()).toBe(100);
    await repo.listAssistantSessions();
    expect(repo.assistantSessionMax()).toBe(25);
  });

  // ── what each mode of the search form actually asks for ────────────────────
  //
  // The form drew a selected button for four scopes and two of them travelled as nothing at all, so choosing them
  // answered exactly what "All files" answers. The shape of the request is the only place that shows.

  const query = (patch: Partial<Parameters<HttpRepository['search']>[0]> = {}): Parameters<HttpRepository['search']>[0] => ({
    text: 'rapor',
    scope: 'all',
    searchIn: 'all',
    drive: null,
    folderPath: '',
    modified: 'any',
    around: null,
    fileType: 'any',
    tags: [],
    ownerId: null,
    size: { preset: 'any', min: null, max: null, unit: 'MB' },
    path: '',
    pathMode: 'only',
    excludePaths: [],
    wholePhrase: false,
    ...patch,
  });

  it('names every scope the server knows, and sends none for the one that is its default', async () => {
    routes = [['/api/files/search', { results: [] }]];
    const repo = new HttpRepository();
    const sent = async (scope: Parameters<HttpRepository['search']>[0]['scope']) => {
      await repo.search(query({ scope }));
      return (calls.at(-1)?.body as Record<string, unknown>).scope;
    };
    // "Paths" is the server's alias of the name scope — a name plus the whole address, never the contents.
    expect(await sent('paths')).toBe('path');
    expect(await sent('content')).toBe('content');
    // Tags used to travel as nothing, so the Tags button searched names, paths AND contents.
    expect(await sent('tags')).toBe('tags');
    expect(await sent('all')).toBeUndefined();
  });

  it('asks for the files the account itself published, and only when that is what was chosen', async () => {
    routes = [['/api/files/search', { results: [] }]];
    const repo = new HttpRepository();
    await repo.search(query({ searchIn: 'shared' }));
    expect((calls.at(-1)?.body as Record<string, unknown>).shared_only).toBe(true);
    await repo.search(query({ searchIn: 'all' }));
    expect(calls.at(-1)?.body).not.toHaveProperty('shared_only');
  });

  it('keeps a tag chip as a tag term while the scope says which fields the text may match', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search(query({ scope: 'tags', text: 'tasa', tags: ['q3'] }));
    const body = calls.at(-1)?.body as Record<string, unknown>;
    expect(body).toMatchObject({ scope: 'tags', query: 'tasa tag:q3' });
  });

  // ── the drive picker ───────────────────────────────────────────────────────

  it('narrows to one drive by its row id, so the count is that drive’s', async () => {
    routes = [
      ['/api/files/storages', { storages: [{ id: 4, name: 'demo', read_only: false }, { id: 9, name: 'work', read_only: false }] }],
      ['/api/files/quota/me', { used_bytes: 0, quota_bytes: 0, unlimited: true }],
      ['/api/files/search', { results: [] }],
    ];
    const repo = new HttpRepository();
    await repo.search(query({ drive: 'work' }));
    expect(calls.at(-1)?.body).toMatchObject({ storage_id: 9 });

    // No drive picked is every drive the account can see, which is what the endpoint answers with no id at all.
    await repo.search(query({ drive: null }));
    expect(calls.at(-1)?.body).not.toHaveProperty('storage_id');
  });

  it('stays unscoped for a drive it cannot resolve, rather than answering about another one', async () => {
    routes = [
      ['/api/files/storages', { storages: [{ name: 'old', read_only: false }] }],
      ['/api/files/quota/me', { used_bytes: 0, quota_bytes: 0, unlimited: true }],
      ['/api/files/search', { results: [{ id: 1, name: 'a.md', path: '/a.md', type: 'file', size: 1, storage: 'old' }] }],
    ];
    // A server too old to send row ids: there is nothing to narrow WITH, so the request carries no id — and the
    // page is sieved by name instead, which is the honest half of what can still be delivered.
    const { hits } = await new HttpRepository().search(query({ drive: 'old' }));
    expect(calls.at(-1)?.body).not.toHaveProperty('storage_id');
    expect(hits.map((h) => h.storageId)).toEqual(['old']);
  });

  // ── the Path box's two directions ──────────────────────────────────────────

  it('confines to the Path box in "only" mode and excludes it in "skip" mode', async () => {
    routes = [['/api/files/search', { results: [] }]];
    const repo = new HttpRepository();
    await repo.search(query({ path: '/demo/design/', pathMode: 'only' }));
    expect(calls.at(-1)?.body).toMatchObject({ query: 'rapor', path_prefix: '/design' });

    await repo.search(query({ path: '/demo/design/', pathMode: 'skip' }));
    const skipped = calls.at(-1)?.body as Record<string, unknown>;
    // The same box, read the other way: an exclusion term, and no confinement — a search restricted to the folder
    // it was told to leave out is the one answer that cannot be right.
    expect(skipped.query).toBe('rapor -path:design');
    expect(skipped).not.toHaveProperty('path_prefix');
  });

  it('quotes a multi-segment folder so the server reads one operator and not two words', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search(query({ path: '/demo/old files/2024/', pathMode: 'skip' }));
    expect((calls.at(-1)?.body as Record<string, unknown>).query).toBe('rapor -path:"old files 2024"');
  });

  it('sends a chip folder and a typed one as separate exclusions', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search(query({ excludePaths: ['Design/Old', 'tmp'], path: '/demo/archive', pathMode: 'skip' }));
    // Chips and the Path box are two acts, not one: pointing at a result does not overwrite what was typed.
    // Case travels as typed; the server folds it, like it folds a tag's.
    expect((calls.at(-1)?.body as Record<string, unknown>).query).toBe('rapor -path:"Design Old" -path:tmp -path:archive');
  });

  it('ignores chip folders while the Path box is confining rather than excluding', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search(query({ excludePaths: ['tmp'], path: '/demo/design', pathMode: 'only' }));
    const body = calls.at(-1)?.body as Record<string, unknown>;
    // The mode belongs to the BOX. The chips keep excluding either way.
    expect(body).toMatchObject({ query: 'rapor -path:tmp', path_prefix: '/design' });
  });

  it('sieves a skipped DRIVE by name, since a node path starts below one', async () => {
    routes = [
      [
        '/api/files/search',
        {
          results: [
            { id: 1, name: 'a.md', path: '/a.md', type: 'file', size: 1, storage: 'demo' },
            { id: 2, name: 'b.md', path: '/b.md', type: 'file', size: 1, storage: 'work' },
          ],
        },
      ],
    ];
    const { hits } = await new HttpRepository().search(query({ path: '/demo', pathMode: 'skip' }));
    // No operator to send — the drive is not part of any node's path — so the request carries the text alone.
    expect((calls.at(-1)?.body as Record<string, unknown>).query).toBe('rapor');
    expect(hits.map((h) => h.storageId)).toEqual(['work']);
  });

  // ── the fields the flat listings carry and the client used to drop ─────────

  it('dates a Recent row by when it was opened, not by when it was written', async () => {
    routes = [
      ['/manager/recent', { nodes: [{ id: 2, storage_id: 1, storage: 'main', name: 'notes.md', path: '/notes.md', type: 'file', size: 5, db_mtime: '2026-01-01T10:00:00Z', opened_at: '2026-07-09T08:30:00Z' }] }],
      ['/star/list', { nodes: [] }],
    ];
    const [node] = await new HttpRepository().listRecent();
    // Without it the page grouped by the mtime and "Today" meant "written today".
    expect(node.openedAt).toBe('2026-07-09T08:30:00Z');
    expect(node.modifiedAt).toBe('2026-01-01T10:00:00Z');
  });

  it('names who shared a row and when, and never falls back to an address', async () => {
    const grant = { id: 5, path: 'main://Docs/plan.md', basename: 'plan.md', type: 'file', extension: 'md', size: 9, storage: 'main', shared_at: Date.parse('2026-07-08T09:00:00Z') };
    routes = [['/shared-with-me', { files: [{ ...grant, shared_by: 4, shared_by_name: 'Grace' }, { ...grant, id: 6, path: 'main://Docs/spec.md', basename: 'spec.md', shared_by: 7 }] }]];
    const [named, nameless] = await new HttpRepository().listShared();
    expect(named).toMatchObject({ sharedBy: 'Grace', sharedAt: '2026-07-08T09:00:00.000Z' });
    // The server withholds the granter's e-mail on purpose; a nameless account gets a neutral word, not an address.
    expect(nameless.sharedBy).toBe('Someone');
    expect(nameless.sharedAt).toBe('2026-07-08T09:00:00.000Z');
  });

  it('keeps a deleted folder a folder, and carries the days it has left', async () => {
    routes = [
      [
        '/manager/trash',
        {
          entries: [
            { id: 9, storage_id: 1, storage_name: 'main', path: '/Design', name: 'Design', type: 'dir', size: 4096, deleted_at: '2026-07-10T12:00:00Z', ttl_days: 23 },
            { id: 10, storage_id: 1, storage_name: 'main', path: '/Design/logo.svg', name: 'logo.svg', type: 'file', size: 900, deleted_at: '2026-07-10T12:00:00Z', ttl_days: 23 },
          ],
        },
      ],
    ];
    const [folder, file] = await new HttpRepository().listTrash();
    // A deleted folder used to arrive as a file: an icon picked by extension and a byte count where a dash belongs.
    expect(folder).toMatchObject({ kind: 'folder', size: 0, ttlDays: 23 });
    expect(file).toMatchObject({ kind: 'file', size: 900, ttlDays: 23 });
  });

  // ── which 409 is a taken name ──────────────────────────────────────────────
  //
  // filex answers 409 for a name collision, for a move across an encryption boundary and for a staged upload whose
  // session is not in the state the call assumes. All three used to reach the user as "duplicate name".

  it('renames through the parent folder and reports a taken name as the shared duplicate error', async () => {
    routes = [['q=rename', { ok: true }], ['q=index', index(row({ id: 4, path: 'main://Docs/plan.md', basename: 'plan.md', type: 'file' }))], ['/star/list', { nodes: [] }]];
    const renamed = await new HttpRepository().rename('main://Docs/notes.md', 'plan.md');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { path: 'main://Docs', item: 'main://Docs/notes.md', name: 'plan.md' } });
    expect(renamed.id).toBe('main://Docs/plan.md');

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, text: async () => '{"error":"exists"}' }) as Response);
    await expect(new HttpRepository().rename('main://Docs/notes.md', 'plan.md')).rejects.toThrow('duplicateName');
  });

  it('leaves every other 409 as the server stated it, because it is not about a name', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, text: async () => '{"error":"cannot move across an encryption boundary"}' }) as Response);
    const repo = new HttpRepository();
    await expect(repo.move(['main://Docs/a.txt'], 'main://Vault')).rejects.toThrow('cannot move across an encryption boundary');
    await expect(repo.copy(['main://Docs/a.txt'], 'main://Vault')).rejects.toThrow('cannot move across an encryption boundary');
    await expect(repo.abortUpload('staged-1')).rejects.toThrow('cannot move across an encryption boundary');
  });

  it('records an open and a star by the numeric id the listing taught it', async () => {
    routes = [['q=index', index(row({ id: 42, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))], ['/star/list', { nodes: [] }], ['/manager/recent', { ok: true }], ['/manager/star', { ok: true }]];
    const repo = new HttpRepository();
    await repo.listFolder('main://Docs');
    await repo.recordOpen('main://Docs/notes.md');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { node_id: 42 } });
    await repo.setStarred(['main://Docs/notes.md'], true);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { node_id: 42, starred: true } });
  });

  // Shared-with-me builds the whole set before paging it, so its full page
  // with the facets in the query is the filtered set, exactly.
  it('sends the chips to shared-with-me and asks for its full page', async () => {
    routes = [['/shared-with-me', { files: [] }]];
    await new HttpRepository().listShared({ fileType: 'documents', modified: 'any', size: 'any', personId: null, name: 'plan', tags: [], around: null });
    const query = new URLSearchParams(calls[0].url.split('?')[1]);
    expect(query.get('limit')).toBe('500');
    expect(query.get('ext')).toBe('md,pdf');
    expect(query.get('name')).toBe('plan');
  });

  // The folder listing is the server's to filter too. Below a thousand entries the store holds the folder whole and
  // sieves it in memory, and `total` — the count BEFORE the filter — is how it knows which case it is in.
  it('sends the chips and the name box to the folder listing and reads the unfiltered total', async () => {
    routes = [
      ['/star/list', { nodes: [] }],
      ['q=index', { ...index(row({ id: 3, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file', size: 5 * 1024 * 1024 })), total: 1500 }],
    ];
    const listing = await new HttpRepository().listFolder('main://Docs', { fileType: 'documents', modified: 'any', size: 'medium', personId: null, name: 'Notes', tags: [], around: null });
    const query = new URLSearchParams(calls[0].url.split('?')[1]);
    expect(query.get('q')).toBe('index');
    expect(query.get('ext')).toBe('md,pdf');
    expect(query.get('name')).toBe('Notes');
    expect(query.get('size_min')).toBe(String(1024 * 1024));
    expect(listing.nodes.map((n) => n.name)).toEqual(['notes.md']);
    expect(listing.total).toBe(1500);
  });

  it('takes the row count for the total when an older server answers none', async () => {
    routes = [['/star/list', { nodes: [] }], ['q=index', index(row({ id: 3, path: 'main://Docs/notes.md', basename: 'notes.md', type: 'file' }))]];
    const listing = await new HttpRepository().listFolder('main://Docs');
    expect(listing.total).toBe(1);
    expect(new URLSearchParams(calls[0].url.split('?')[1]).has('ext')).toBe(false);
  });

  // The server wraps each matched term in « », and the search page printed
  // those guillemets as if they were part of the file.
  it('reads the server\'s match markers as highlights instead of printing them', async () => {
    routes = [
      [
        '/api/files/search',
        {
          results: [
            {
              id: 4,
              storage: 'main',
              path: '/Docs/maas.md',
              name: 'maas.md',
              type: 'file',
              size: 12,
              snippet: 'the «annual» report and its «annual» summary',
            },
          ],
        },
      ],
    ];
    const { hits } = await new HttpRepository().search({
      text: 'annual',
      scope: 'content',
      wholePhrase: false,
      tags: [],
      searchIn: 'all',
      drive: null,
      folderPath: '',
      path: '',
      pathMode: 'only',
      excludePaths: [],
      around: null,
      fileType: 'any',
      modified: 'any',
      size: { preset: 'any', min: null, max: null, unit: 'MB' },
      ownerId: null,
    });

    expect(hits[0].snippet?.text).toBe('the annual report and its annual summary');
    expect(hits[0].snippet?.ranges).toEqual([
      { start: 4, end: 10 },
      { start: 26, end: 32 },
    ]);
  });

  // ── who owns a row ──────────────────────────────────────────────────────────
  //
  // The flat listings answer with node rows, which carry `owner_id`. The client
  // used to throw it away and stamp the CALLER onto every row, so starred,
  // recent and search all printed "You" over files somebody else had put on a
  // shared drive. On a shared drive that is not a harmless default: it is a
  // false statement about who put the file there.

  it('keeps the owner filex named on the flat listings instead of claiming every file', async () => {
    const mine = { id: 2, storage_id: 1, storage: 'main', name: 'benim.md', path: '/benim.md', type: 'file', size: 5, owner_id: 1, owner_name: 'Ada' };
    const theirs = { id: 3, storage_id: 1, storage: 'main', name: 'onun.md', path: '/onun.md', type: 'file', size: 5, owner_id: 9, owner_name: 'Grace' };
    // No owner at all — what a storage sync found rather than a person uploading.
    const nobody = { id: 4, storage_id: 1, storage: 'main', name: 'bulunan.md', path: '/bulunan.md', type: 'file', size: 5 };
    routes = [
      ['/api/auth/me', { user: { id: 1, email: 'ada@filex.test', display_name: 'Ada', role: 'user' } }],
      ['/star/list', { nodes: [mine, theirs, nobody] }],
    ];
    const repo = new HttpRepository();
    await repo.currentUser();
    const starred = await repo.listStarred();

    expect(starred.map((n) => [n.name, n.ownerId, n.ownerName])).toEqual([
      ['benim.md', '1', 'Ada'],
      ['onun.md', '9', 'Grace'],
      // Unowned falls back to the caller, which is the honest answer: everything they can see, they can see.
      ['bulunan.md', '1', undefined],
    ]);
  });

  it('offers the People chip the owners those rows actually named', async () => {
    routes = [
      ['/api/auth/me', { user: { id: 1, email: 'ada@filex.test', display_name: 'Ada', role: 'user' } }],
      [
        '/star/list',
        { nodes: [{ id: 3, storage_id: 1, storage: 'main', name: 'onun.md', path: '/onun.md', type: 'file', size: 5, owner_id: 9, owner_name: 'Grace' }] },
      ],
    ];
    const repo = new HttpRepository();
    await repo.currentUser();
    await repo.listStarred();

    // The caller is always an option; the point is that the OTHER owner is one too, learned from the rows.
    expect(await repo.listFilterPeople()).toEqual([
      { id: '9', name: 'Grace', initial: 'G', role: 'owner', principal: 'user' },
      { id: '1', name: 'Ada', initial: 'A', role: 'owner', principal: 'user' },
    ]);
  });

  // ── the destination picker's tree ───────────────────────────────────────────

  it('asks for one level of folders at a time', async () => {
    routes = [['q=subfolders', { folders: [row({ id: 7, path: 'main://Docs/Q1', basename: 'Q1' })] }]];
    const folders = await new HttpRepository().listSubfolders('main://Docs');

    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0].url.split('?')[1]).get('path')).toBe('main://Docs');
    expect(folders.map((n) => n.id)).toEqual(['main://Docs/Q1']);
  });

  it('walks the whole tree a LEVEL per round trip, not a folder per round trip', async () => {
    // Two folders at the root, each holding one. Done one folder at a time that is four awaited requests in a row;
    // done a level at a time it is three, and the two second-level ones go out together.
    const children: Record<string, unknown> = {
      'main://': { folders: [row({ id: 1, path: 'main://A', basename: 'A' }), row({ id: 2, path: 'main://B', basename: 'B' })] },
      'main://A': { folders: [row({ id: 3, path: 'main://A/A1', basename: 'A1' })] },
      'main://B': { folders: [row({ id: 4, path: 'main://B/B1', basename: 'B1' })] },
    };
    const started: string[] = [];
    routes = [
      [
        'q=subfolders',
        (call: { url: string }) => {
          const path = new URLSearchParams(call.url.split('?')[1]).get('path') ?? '';
          started.push(path);
          return children[path] ?? { folders: [] };
        },
      ],
    ];
    const folders = await new HttpRepository().listFolders('main');

    expect(folders.map((n) => n.name)).toEqual(['main', 'A', 'B', 'A1', 'B1']);
    // The order proves the shape: a level is asked for as a whole before any of its answers are read.
    expect(started.slice(0, 3)).toEqual(['main://', 'main://A', 'main://B']);
  });

  it('asks the server for folders by name, and keeps only the drive it was asked about', async () => {
    routes = [
      [
        '/api/files/search',
        {
          results: [
            { id: 5, storage_id: 1, storage: 'main', name: 'Brand', path: '/Design/Brand', type: 'dir', size: 0 },
            { id: 6, storage_id: 2, storage: 'archive', name: 'Brand', path: '/Old/Brand', type: 'dir', size: 0 },
          ],
        },
      ],
    ];
    const folders = await new HttpRepository().searchFolders('main', 'brand');

    expect(calls[0].body).toMatchObject({ query: 'brand', dirs_only: true });
    // The drive is sieved here rather than sent: the app addresses drives by name and has no numeric id to send.
    expect(folders.map((n) => n.id)).toEqual(['main://Design/Brand']);
  });

  // ── the advanced form's last three ──────────────────────────────────────────

  const form = (patch: Record<string, unknown> = {}) =>
    ({
      text: 'report', tags: [], scope: 'all', searchIn: 'all', drive: null, folderPath: '', path: '', around: null,
      pathMode: 'only', excludePaths: [],
      fileType: 'any', modified: 'any', size: { preset: 'any', min: null, max: null, unit: 'MB' },
      ownerId: null, wholePhrase: false, ...patch,
    }) as unknown as Parameters<HttpRepository['search']>[0];

  // The Path box used to be a no-op over HTTP: the mock honoured it, the server was never told, and a person
  // typing a folder got results from everywhere with no sign of it.
  it('sends the typed Path as a prefix and keeps only the drive it names', async () => {
    routes = [
      [
        '/api/files/search',
        {
          results: [
            { id: 1, storage_id: 1, storage: 'main', name: 'q1.pdf', path: '/Design/q1.pdf', type: 'file', size: 5 },
            { id: 2, storage_id: 2, storage: 'archive', name: 'q1.pdf', path: '/Design/q1.pdf', type: 'file', size: 5 },
          ],
        },
      ],
    ];
    const { hits } = await new HttpRepository().search(form({ path: '/main/Design/' }));

    // The drive comes off: `path_prefix` is relative to the storage. The drive itself cannot be sent — the request
    // carries no storage id — so it is applied to the answer, which is exact because the answer is the whole answer.
    expect(calls[0].body).toMatchObject({ path_prefix: '/Design' });
    expect(hits.map((h) => h.node.id)).toEqual(['main://Design/q1.pdf']);
  });

  it('turns a hand-typed size range into bytes instead of sieving the answer', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search(form({ size: { preset: 'custom', min: 2, max: 5, unit: 'MB' } }));

    expect(calls[0].body).toMatchObject({ size_min: 2 * 1024 ** 2, size_max: 5 * 1024 ** 2 });
  });

  it('asks nothing at all when the Path box and the folder scope name folders neither of which holds the other', async () => {
    routes = [['/api/files/search', { results: [] }]];
    const result = await new HttpRepository().search(form({ path: '/main/Design', searchIn: 'current', folderPath: 'Docs' }));

    // Nothing can be inside both, and that is an answer rather than a request.
    expect(calls).toHaveLength(0);
    expect(result).toEqual({ hits: [], total: 0, capped: false });
  });

  it('takes the deeper of the two when they agree', async () => {
    routes = [['/api/files/search', { results: [] }]];
    await new HttpRepository().search(form({ path: '/main/Design/Brand', searchIn: 'current', folderPath: 'Design' }));

    expect(calls[0].body).toMatchObject({ path_prefix: '/Design/Brand' });
  });

  it('carries the server’s “there is more” through, so the count can say so', async () => {
    routes = [['/api/files/search', { results: [], capped: true }]];
    expect((await new HttpRepository().search(form())).capped).toBe(true);

    routes = [['/api/files/search', { results: [] }]];
    expect((await new HttpRepository().search(form())).capped).toBe(false);
  });
});
