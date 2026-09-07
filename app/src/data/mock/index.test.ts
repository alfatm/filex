import { beforeEach, describe, expect, it } from 'vitest';
import { DUPLICATE_NAME } from '../repository';
import type { SearchQuery } from '../types';
import { mockRepository as repo, resetMock } from './index';

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
  caseSensitive: false,
  ocr: false,
};

describe('mock repository mutations', () => {
  beforeEach(resetMock);

  it('trash → restore → emptyTrash keeps folder listings and item counts consistent', async () => {
    expect((await repo.getNode('demo')).itemCount).toBe(16);
    await repo.moveToTrash(['archive', 'data-csv']);
    expect(names(await repo.listFolder('demo'))).not.toContain('Archive');
    const trash = await repo.listTrash();
    expect(names(trash)).toEqual(['Archive', 'data.csv']);
    expect(trash.every((n) => n.deletedAt && n.originalPath === '/demo')).toBe(true);
    expect((await repo.getNode('demo')).itemCount).toBe(14);
    await expect(repo.resolvePath('demo', 'Archive')).rejects.toThrow('path not found');

    await repo.restore(['archive']);
    expect(names(await repo.listFolder('demo'))).toContain('Archive');
    expect((await repo.getNode('archive')).deletedAt).toBeUndefined();
    expect((await repo.getNode('demo')).itemCount).toBe(15);

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
    expect(Date.parse(node.modifiedAt)).toBeGreaterThan(Date.parse(before));
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
    expect((await repo.getNode('demo')).itemCount).toBe(18);
    expect(names(await repo.listFolder('demo'))).toContain('summary.pdf');
    expect((await repo.getPath(file.id)).map((n) => n.id)).toEqual(['demo']);
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
    expect((await repo.getNode('demo')).itemCount).toBe(15);
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
    expect(listed.map((n) => n.modifiedAt.slice(0, 13))).toEqual(listed.map((_, i) => `2026-07-01T0${8 - i}`));
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
    expect(Date.parse(recent[0].openedAt!)).toBeGreaterThan(Date.parse(recent[1].modifiedAt));
    expect(recent[1].name).toBe('Q3 report.pdf');
    // The search-only reference hits can be opened too.
    await repo.recordOpen('design/overview-pdf');
    await expect(repo.recordOpen('nope')).rejects.toThrow('node not found');
  });

  it('every file carries the asset URL of its real file', async () => {
    const code = await repo.listFolder('code');
    expect(code.every((n) => n.assetUrl?.startsWith('/app/demo-assets/Code/'))).toBe(true);
    expect((await repo.getNode('code/dockerfile')).assetUrl).toBe('/app/demo-assets/Code/Dockerfile');
    expect((await repo.getNode('ui-design-fig')).assetUrl).toBe('/app/demo-assets/UI%20Design.fig');
  });
});
