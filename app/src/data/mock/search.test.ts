import { describe, expect, it } from 'vitest';
import type { SearchQuery } from '../types';
import { nodes } from './dataset';
import { search } from './search';

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
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
    ocr: true,
    ...overrides,
  };
}

describe('mock search', () => {
  it('skips trashed nodes', () => {
    const readme = nodes.find((n) => n.id === 'readme-md')!;
    const hits = () => search(query({ text: 'README' })).hits.map((h) => [h.node.name, h.folderPath]);
    expect(hits()).toEqual([
      ['README.md', ''],
      ['README.md', 'Code'],
    ]);
    readme.deletedAt = '2026-09-01T00:00:00';
    try {
      expect(hits()).toEqual([['README.md', 'Code']]);
    } finally {
      delete readme.deletedAt;
    }
  });

  it('returns the reference hits for "design" first and counts every hit', () => {
    const { hits, total } = search(query({ text: 'design' }));
    expect(total).toBe(hits.length);
    // The root README mentions the Design folder; the 8 real files in /demo/Design match by path.
    expect(hits.map((h) => h.node.name)).toEqual([
      'Design',
      'overview.pdf',
      'beach.png',
      'README.md',
      'UI Design.fig',
      'Brand Guidelines.pdf',
      'animation.gif',
      'dashboard.png',
      'file-browser.jpg',
      'illustration.webp',
      'logo.svg',
      'source-design.psd',
      'wireframe.png',
      'contacts.csv',
    ]);
    expect(hits.slice(0, 3).map((h) => [h.node.name, h.folderPath])).toEqual([
      ['Design', ''],
      ['overview.pdf', 'Design'],
      ['beach.png', 'Design'],
    ]);
    expect(hits[0].storageId).toBe('demo');
    expect(hits[0].node.itemCount).toBe(8);
    expect(hits[0].snippet).toBeUndefined();
    expect(hits[1].snippet).toEqual({
      text: '… product design guidelines and brand assets …',
      ranges: [{ start: 10, end: 16 }],
    });
    expect(hits[2].snippet?.text).toBe('… summer campaign design concept …');
  });

  it('reference form state (no text, tags + path) yields exactly the three rows', () => {
    const { hits } = search(query({ tags: ['design', 'project alpha'], path: '/demo/design/', searchIn: 'current' }));
    expect(hits.map((h) => h.node.name)).toEqual(['Design', 'overview.pdf', 'beach.png']);
    expect(hits[2].snippet?.ranges).toEqual([{ start: 18, end: 24 }]);
  });

  it('respects scope, OCR and path filters', () => {
    const names = (hits: { node: { name: string } }[]) => hits.map((h) => h.node.name);
    expect(names(search(query({ text: 'design', scope: 'content' })).hits)).toEqual(['overview.pdf', 'beach.png', 'README.md', 'contacts.csv']);
    expect(names(search(query({ text: 'design', scope: 'content', ocr: false })).hits)).toEqual(['overview.pdf', 'README.md', 'contacts.csv']);
    const paths = names(search(query({ text: 'design', scope: 'paths' })).hits);
    expect(paths.slice(0, 4)).toEqual(['Design', 'overview.pdf', 'beach.png', 'UI Design.fig']);
    expect(paths).toHaveLength(12);
    // The Design folder, the two indexed hits and its 8 real files.
    expect(search(query({ text: 'design', path: '/demo/design' })).hits).toHaveLength(11);
    expect(search(query({ text: 'nothing-here' }))).toEqual({ hits: [], total: 0 });
  });

  it('restricts the current-folder scope to a nested folder path', () => {
    const inDesign = search(query({ searchIn: 'current', folderPath: 'Design' })).hits;
    expect(inDesign.map((h) => h.node.name).slice(0, 3)).toEqual(['overview.pdf', 'beach.png', 'Brand Guidelines.pdf']);
    expect(inDesign).toHaveLength(10);
    expect(inDesign.every((h) => h.folderPath === 'Design')).toBe(true);
    expect(search(query({ searchIn: 'current', folderPath: 'Design/Nope' })).hits).toEqual([]);
    // The root scope also lists the Design folder itself.
    expect(search(query({ searchIn: 'current', folderPath: '' })).hits.map((h) => h.node.name)).toContain('Design');
  });

  it('applies the modified window relative to `now`', () => {
    const now = Date.parse('2026-07-10T18:00:00');
    const names = (hits: { node: { name: string } }[]) => hits.map((h) => h.node.name);
    const today = search(query({ modified: 'today' }), now).hits;
    expect(today.every((h) => now - Date.parse(h.node.modifiedAt) <= 24 * 60 * 60 * 1000)).toBe(true);
    expect(names(today)).toContain('README.md');
    expect(names(today)).not.toContain('mountains.jpg');
    // demo.mp4 (Jul 3, 16:55) fell out of the 7-day window an hour ago.
    const week = names(search(query({ modified: 'week' }), now).hits);
    expect(week).toContain('mountains.jpg');
    expect(week).not.toContain('demo.mp4');
    expect(names(search(query({ modified: 'month' }), now).hits)).toContain('demo.mp4');
  });

  it('applies type, size, owner and case filters', () => {
    const images = search(query({ fileType: 'images' })).hits;
    expect(images.map((h) => h.node.name).slice(0, 3)).toEqual(['beach.png', 'mountains.jpg', 'beach.png']);
    expect(images).toHaveLength(66);
    expect(images.every((h) => h.node.fileType === 'image')).toBe(true);
    expect(search(query({ size: { preset: 'custom', min: 10, max: 20, unit: 'MB' } })).hits.map((h) => h.node.name)).toEqual([
      'mountains.jpg',
      'UI Design.fig',
    ]);
    expect(search(query({ ownerId: 'someone-else' })).hits).toHaveLength(0);
    expect(search(query({ text: 'design', caseSensitive: true })).hits.map((h) => h.node.name)).toEqual([
      'Design',
      'overview.pdf',
      'beach.png',
      'README.md',
      'source-design.psd',
    ]);
    expect(search(query({ text: 'brand assets', wholePhrase: true, scope: 'content' })).hits.map((h) => h.node.name)).toEqual(['overview.pdf']);
    expect(search(query({ text: 'assets brand', scope: 'content' })).hits.map((h) => h.node.name)).toEqual(['overview.pdf']);
    expect(search(query({ text: 'assets brand', wholePhrase: true, scope: 'content' })).hits).toHaveLength(0);
  });

  it('cuts a window around the first match out of the indexed excerpt', () => {
    const readme = search(query({ text: 'roadmap', scope: 'content' })).hits.find((h) => h.node.id === 'readme-md')!;
    const { text, ranges } = readme.snippet!;
    expect(text).toMatch(/^… .*roadmap.* …$/);
    expect(text.length).toBeLessThanOrEqual('… '.length + 120 + ' …'.length);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['roadmap']);
  });
});
