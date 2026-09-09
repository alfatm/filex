import { beforeEach, describe, expect, it } from 'vitest';
import { DUPLICATE_NAME } from '../repository';
import type { ListingFilter, SearchQuery } from '../types';
import { mockRepository as repo, resetMock } from './index';
import { matchesFilter } from './search';

const names = (nodes: { name: string }[]) => nodes.map((n) => n.name).sort();

const emptyQuery: SearchQuery = {
  text: '',
  scope: 'all',
  searchIn: 'all',
  folderPath: '',
  modified: 'any',
  fileType: 'any',
  tags: [],
  ownerId: null,
  size: { preset: 'any', min: null, max: null, unit: 'MB' },
  path: '',
  wholePhrase: false,
};

const filter = (patch: Partial<ListingFilter> = {}): ListingFilter => ({
  fileType: 'any',
  modified: 'any',
  size: 'any',
  personId: null,
  ...patch,
});

describe('listing filter', () => {
  beforeEach(resetMock);

  it('narrows a folder listing by type, dropping folders with it', async () => {
    expect(names(await repo.listFolder('demo', filter())).length).toBe(17);
    expect(names(await repo.listFolder('demo', filter({ fileType: 'images' })))).toEqual(['beach.png', 'mountains.jpg']);
    expect(names(await repo.listFolder('demo', filter({ fileType: 'design' })))).toEqual(['Mechanical UI KIT 1.0 (Community).fig', 'UI Design.fig']);
  });

  it('narrows by size, which is a file property too', async () => {
    // README.md 2.4 KB and app.ts 4.8 KB are the only sub-megabyte files of the root.
    expect(names(await repo.listFolder('demo', filter({ size: 'small' })))).toEqual(['README.md', 'app.ts', 'data.csv']);
    expect(names(await repo.listFolder('demo', filter({ size: 'large' })))).toEqual([]);
  });

  // The dataset is pinned to July 2026, so the window is checked against a fixed clock rather than the real one.
  it('narrows by the modification window, keeping folders', async () => {
    const now = Date.parse('2026-07-10T16:00:00Z');
    const root = await repo.listFolder('demo');
    const week = root.filter((n) => matchesFilter(n, filter({ modified: 'week' }), now));
    expect(names(week)).toEqual([
      'Code',
      'Mechanical UI KIT 1.0 (Community).fig',
      'README.md',
      'UI Design.fig',
      'app.ts',
      'beach.png',
      'data.csv',
      'mountains.jpg',
      'overview.pdf',
    ]);
    expect(week.some((n) => n.kind === 'folder')).toBe(true);
    // Two: the newest reference file, and the asset dated after the pinned clock — "within the last day" holds for
    // anything not older than that, which is also how a server behaves when a client's clock runs behind.
    expect(root.filter((n) => matchesFilter(n, filter({ modified: 'today' }), now))).toHaveLength(2);
  });

  it('narrows Shared with me by owner, and offers exactly those owners', async () => {
    const people = await repo.listFilterPeople();
    expect(people.map((p) => p.name)).toEqual(['demo', 'Alice Johnson', 'Marcus Lee']);
    const marcus = people.find((p) => p.name === 'Marcus Lee')!;
    const shared = await repo.listShared(filter({ personId: marcus.id }));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((n) => n.sharedBy === 'Marcus Lee')).toBe(true);
    expect(await repo.listShared(filter({ personId: 'nobody' }))).toEqual([]);
  });

  it('applies to every flat listing', async () => {
    expect((await repo.listStarred(filter({ fileType: 'images' }))).every((n) => n.fileType === 'image')).toBe(true);
    expect(await repo.listRecent(filter({ fileType: 'videos' }))).toHaveLength(1);
    await repo.moveToTrash(['archive', 'data-csv']);
    expect(names(await repo.listTrash(filter({ fileType: 'spreadsheets' })))).toEqual(['data.csv']);
  });
});

describe('mock repository mutations', () => {
  beforeEach(resetMock);

  it('trash → restore → emptyTrash keeps folder listings and item counts consistent', async () => {
    expect((await repo.getNode('demo')).itemCount).toBe(17);
    await repo.moveToTrash(['archive', 'data-csv']);
    expect(names(await repo.listFolder('demo'))).not.toContain('Archive');
    const trash = await repo.listTrash();
    expect(names(trash)).toEqual(['Archive', 'data.csv']);
    expect(trash.every((n) => n.deletedAt && n.originalPath === '/demo')).toBe(true);
    expect((await repo.getNode('demo')).itemCount).toBe(15);
    await expect(repo.resolvePath('demo', 'Archive')).rejects.toThrow('path not found');

    await repo.restore(['archive']);
    expect(names(await repo.listFolder('demo'))).toContain('Archive');
    expect((await repo.getNode('archive')).deletedAt).toBeUndefined();
    expect((await repo.getNode('demo')).itemCount).toBe(16);

    await repo.emptyTrash();
    expect(await repo.listTrash()).toEqual([]);
    await expect(repo.getNode('data-csv')).rejects.toThrow('node not found');
    expect(names(await repo.listRecent())).not.toContain('data.csv');
  });

  it('deleteForever removes a folder with its descendants', async () => {
    await repo.deleteForever(['shared']);
    await expect(repo.getNode('shared/q3-report-pdf')).rejects.toThrow('node not found');
    expect(await repo.listShared()).toEqual([]);
  });

  it('renames in place and bumps modifiedAt', async () => {
    const before = (await repo.getNode('readme-md')).modifiedAt;
    const node = await repo.rename('readme-md', 'GUIDE.md');
    expect(node.name).toBe('GUIDE.md');
    expect(Date.parse(node.modifiedAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''));
    expect(names(await repo.listFolder('demo'))).toContain('GUIDE.md');
  });

  it('stars and unstars; trashed items leave the starred list', async () => {
    expect(names(await repo.listStarred())).toEqual(['Photos', 'UI Design.fig', 'mountains.jpg']);
    await repo.setStarred(['readme-md'], true);
    expect(names(await repo.listStarred())).toContain('README.md');
    await repo.setStarred(['photos', 'readme-md'], false);
    expect(names(await repo.listStarred())).toEqual(['UI Design.fig', 'mountains.jpg']);
    await repo.moveToTrash(['ui-design-fig', 'mountains-jpg']);
    expect(await repo.listStarred()).toEqual([]);
  });

  it('share links are stable per node and removable', async () => {
    const url = await repo.createShareLink('design');
    expect(url).toMatch(/^https:\/\/filex\.example\/s\//);
    expect(await repo.createShareLink('design')).toBe(url);
    expect((await repo.getNode('design')).shared).toBe(true);
    await repo.removeShareLink('design');
    expect((await repo.getNode('design')).shareUrl).toBeUndefined();
  });

  it('creates folders and uploads, moves nodes and refuses cycles', async () => {
    const folder = await repo.createFolder('demo', 'Reports');
    expect(folder.itemCount).toBe(0);
    const file = await repo.uploadFile(folder.id, { name: 'summary.pdf', size: 1234 });
    expect(file.fileType).toBe('pdf');
    expect((await repo.getNode(folder.id)).itemCount).toBe(1);
    await repo.move(['readme-md'], folder.id);
    expect(names(await repo.listFolder(folder.id))).toEqual(['README.md', 'summary.pdf']);
    await expect(repo.move([folder.id], folder.id)).rejects.toThrow('into itself');
    expect(names(await repo.listFolders('demo'))).toContain('Reports');
  });

  it('moves a grandchild up two levels, fixing both item counts', async () => {
    const reports = await repo.createFolder('demo', 'Reports');
    const q3 = await repo.createFolder(reports.id, 'Q3');
    const file = await repo.uploadFile(q3.id, { name: 'summary.pdf', size: 10 });
    await repo.move([file.id], 'demo');
    expect((await repo.getNode(q3.id)).itemCount).toBe(0);
    expect((await repo.getNode('demo')).itemCount).toBe(19);
    expect(names(await repo.listFolder('demo'))).toContain('summary.pdf');
    expect((await repo.getPath(file.id)).map((n) => n.id)).toEqual(['demo']);
  });

  it('copies a folder with its subtree, and names a copy that would collide', async () => {
    const reports = await repo.createFolder('demo', 'Reports');
    await repo.uploadFile(reports.id, { name: 'summary.pdf', size: 10 });

    // Into another folder: the copy keeps its own name, and the subtree comes along.
    await repo.copy([reports.id], 'design');
    const landed = (await repo.listFolder('design')).find((n) => n.name === 'Reports')!;
    expect(landed.id).not.toBe(reports.id);
    expect(names(await repo.listFolder(landed.id))).toEqual(['summary.pdf']);
    // A copy is a new node: it inherits neither the star nor the share link of its original.
    expect(landed.starred).toBe(false);
    expect(landed.shared).toBe(false);

    // Into its own folder: the name is taken, so the server-side suffix decides, twice over.
    await repo.copy([reports.id], 'demo');
    await repo.copy([reports.id], 'demo');
    const here = names(await repo.listFolder('demo'));
    expect(here).toContain('Reports');
    expect(here).toContain('Reports-copy');
    expect(here).toContain('Reports-copy-2');
  });

  it('rejects name collisions among live siblings for createFolder and rename', async () => {
    await expect(repo.createFolder('demo', 'Design')).rejects.toThrow(DUPLICATE_NAME);
    await expect(repo.rename('code', 'Design')).rejects.toThrow(DUPLICATE_NAME);
    await expect(repo.rename('readme-md', 'app.ts')).rejects.toThrow(DUPLICATE_NAME);
    // Renaming to the own name and reusing a trashed sibling's name are fine; other folders are separate namespaces.
    await expect(repo.rename('code', 'Code')).resolves.toMatchObject({ name: 'Code' });
    await repo.moveToTrash(['archive']);
    await expect(repo.createFolder('demo', 'Archive')).resolves.toMatchObject({ name: 'Archive' });
    await expect(repo.createFolder('design', 'Code')).resolves.toMatchObject({ parentId: 'design' });
  });

  it('hides the subtree of a trashed folder everywhere and lists only its top in the trash', async () => {
    await repo.moveToTrash(['shared']);
    expect(await repo.listShared()).toEqual([]);
    expect(names(await repo.listRecent())).not.toContain('Q3 report.pdf');
    expect(names(await repo.listFolders('demo'))).not.toContain('Brand assets');
    expect(names(await repo.listTrash())).toEqual(['Shared']);
    const hits = (await repo.search({ ...emptyQuery, text: 'roadmap' })).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.node.name === 'Roadmap.md' || h.folderPath === 'Shared')).toBe(false);
    await expect(repo.resolvePath('demo', 'Shared/Brand assets')).rejects.toThrow('path not found');

    await repo.restore(['shared']);
    expect(names(await repo.listShared())).toHaveLength(3);
    expect(names(await repo.listFolder('shared'))).toContain('Brand assets');
  });

  it('emptyTrash removes trashed folders with nested content, including items trashed separately inside', async () => {
    await repo.moveToTrash(['shared/roadmap-md']);
    await repo.moveToTrash(['shared']);
    expect(names(await repo.listTrash())).toEqual(['Shared']);
    await repo.emptyTrash();
    expect(await repo.listTrash()).toEqual([]);
    for (const id of ['shared', 'shared/roadmap-md', 'shared/brand-assets', 'shared/q3-report-pdf']) {
      await expect(repo.getNode(id)).rejects.toThrow('node not found');
    }
    expect((await repo.getNode('demo')).itemCount).toBe(16);
  });

  it('navigates demo → Design and lists the 8 real files of the asset tree', async () => {
    const design = await repo.resolvePath('demo', 'Design');
    expect(design.id).toBe('design');
    expect(design.itemCount).toBe(8);
    const listed = await repo.listFolder(design.id);
    expect(names(listed)).toEqual([
      'Brand Guidelines.pdf',
      'animation.gif',
      'dashboard.png',
      'file-browser.jpg',
      'illustration.webp',
      'logo.svg',
      'source-design.psd',
      'wireframe.png',
    ]);
    // Real sizes and the served file for every kind; dates one hour apart below the folder's reference date.
    const logo = listed.find((n) => n.name === 'logo.svg')!;
    expect(logo).toMatchObject({ id: 'design/logo-svg', size: 684, fileType: 'image', assetUrl: '/app/demo-assets/Design/logo.svg' });
    expect(listed.find((n) => n.name === 'Brand Guidelines.pdf')?.assetUrl).toBe('/app/demo-assets/Design/Brand%20Guidelines.pdf');
    expect(listed.map((n) => n.modifiedAt?.slice(0, 13))).toEqual(listed.map((_, i) => `2026-07-01T0${8 - i}`));
    expect((await repo.getPath('design/logo-svg')).map((n) => n.id)).toEqual(['demo', 'design']);
    expect(names(await repo.listFolders('demo'))).toContain('Design');
  });

  it('root folder item counts come from the real children (Shared also carries the 3 shared-with-me nodes)', async () => {
    const counts: Record<string, number> = {};
    for (const folder of (await repo.listFolder('demo')).filter((n) => n.kind === 'folder')) {
      counts[folder.name] = folder.itemCount!;
      const extra = folder.id === 'shared' ? 3 : 0;
      expect((await repo.listFolder(folder.id)).length).toBe(folder.itemCount! + extra);
    }
    expect(counts).toEqual({ Code: 12, Design: 8, Documents: 24, Photos: 56, example: 3, Archive: 17, Resources: 9, Shared: 5 });
  });

  it('listShared / listRecent expose the shared-with-me nodes', async () => {
    const shared = await repo.listShared();
    expect(shared.map((n) => n.sharedBy)).toEqual(['Alice Johnson', 'Marcus Lee', 'Alice Johnson']);
    const recent = await repo.listRecent();
    expect(recent[0].name).toBe('Q3 report.pdf');
    expect(recent.every((n) => n.kind === 'file')).toBe(true);
  });

  it('recordOpen moves the file to the top of Recent; the modification date is the fallback order', async () => {
    await repo.recordOpen('mountains-jpg');
    const recent = await repo.listRecent();
    expect(recent[0].name).toBe('mountains.jpg');
    expect(Date.parse(recent[0].openedAt!)).toBeGreaterThan(Date.parse(recent[1].modifiedAt ?? ''));
    expect(recent[1].name).toBe('Q3 report.pdf');
    // The search-only reference hits can be opened too.
    await repo.recordOpen('design/overview-pdf');
    await expect(repo.recordOpen('nope')).rejects.toThrow('node not found');
  });

  // filex snapshots a file's bytes BEFORE overwriting them, so no row on the timeline is the live file, and a
  // restore adds a row for what the file was a moment ago rather than one labelled as the present contents.
  it('a revision is what the file used to be, and restoring one keeps what it was replacing', async () => {
    const before = await repo.listVersions('shared/q3-report-pdf');
    const node = await repo.getNode('shared/q3-report-pdf');
    expect(before.length).toBeGreaterThan(0);
    // Every row is older and smaller than the live file: none of them describes it.
    expect(before.every((v) => v.size < node.size)).toBe(true);
    expect(before.every((v) => Date.parse(v.at) < Date.parse(node.modifiedAt!))).toBe(true);

    await repo.restoreVersion('shared/q3-report-pdf', before[1].id);
    const after = await repo.listVersions('shared/q3-report-pdf');
    // One row more, and the new one holds the size the file had before the rollback.
    expect(after.length).toBe(before.length + 1);
    expect(after[0].size).toBe(node.size);
    expect(after.slice(1)).toEqual(before);
    expect((await repo.getNode('shared/q3-report-pdf')).size).toBe(before[1].size);
  });

  it('every file carries the asset URL of its real file', async () => {
    const code = await repo.listFolder('code');
    expect(code.every((n) => n.assetUrl?.startsWith('/app/demo-assets/Code/'))).toBe(true);
    expect((await repo.getNode('code/dockerfile')).assetUrl).toBe('/app/demo-assets/Code/Dockerfile');
    expect((await repo.getNode('ui-design-fig')).assetUrl).toBe('/app/demo-assets/UI%20Design.fig');
  });
});

describe('mock assistant conversations', () => {
  const drain = async (prompt: string, id: string) => {
    const seen = [];
    for await (const event of repo.assistantAsk(prompt, 'filename', id, new AbortController().signal)) seen.push(event);
    return seen;
  };

  it('names an unnamed conversation from the question, once', async () => {
    const session = await repo.createAssistantSession();
    const first = await drain('find the design guidelines please', session.id);
    expect(first).toContainEqual({ type: 'title', title: 'Find the design guidelines please' });
    expect((await repo.listAssistantSessions()).find((s) => s.id === session.id)?.title).toBe('Find the design guidelines please');

    const second = await drain('and the photos?', session.id);
    expect(second.some((e) => e.type === 'title')).toBe(false);
  });

  it('leaves a conversation the person named alone', async () => {
    const session = await repo.createAssistantSession('Q3 contracts');
    const events = await drain('find the design guidelines', session.id);
    expect(events.some((e) => e.type === 'title')).toBe(false);
    expect((await repo.listAssistantSessions()).find((s) => s.id === session.id)?.title).toBe('Q3 contracts');
  });
});
