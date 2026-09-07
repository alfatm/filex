import { describe, expect, it } from 'vitest';
import type { Node } from '@/data/types';
import { CSV_MAX_ROWS, downloadUrl, parseCsv, previewKind, previewList, splitLines, TEXT_MAX_BYTES } from './preview';

const file = (name: string, extra: Partial<Node> = {}): Node =>
  ({ id: name, name, kind: 'file', size: 100, assetUrl: `/app/demo-assets/${name}`, fileType: 'other', ...extra }) as Node;

describe('previewKind', () => {
  it('maps the node type and extension to a renderer', () => {
    expect(previewKind(file('a.jpg', { fileType: 'image' }))).toBe('image');
    expect(previewKind(file('a.mp4', { fileType: 'mp4' }))).toBe('video');
    expect(previewKind(file('a.pdf', { fileType: 'pdf' }))).toBe('pdf');
    expect(previewKind(file('a.csv', { fileType: 'csv' }))).toBe('csv');
    expect(previewKind(file('README.md', { fileType: 'md' }))).toBe('text');
    expect(previewKind(file('app.ts', { fileType: 'ts' }))).toBe('text');
    for (const name of ['a.txt', 'a.json', 'a.yaml', 'a.yml', 'a.xml', 'a.ics', 'a.vcf', 'a.py', 'a.go', 'a.css', 'a.html', 'a.sql', 'a.sh', 'Dockerfile', 'a.toml', '.env', 'a.log']) {
      expect(previewKind(file(name)), name).toBe('text');
    }
    for (const name of ['a.docx', 'a.xlsx', 'a.fig', 'a.psd', 'a.zip', 'a.sqlite']) expect(previewKind(file(name)), name).toBe('none');
  });

  it('needs an asset URL and keeps text under the size limit', () => {
    expect(previewKind(file('a.jpg', { fileType: 'image', assetUrl: undefined }))).toBe('none');
    expect(previewKind(file('big.txt', { size: TEXT_MAX_BYTES + 1 }))).toBe('none');
    expect(previewKind(file('big.csv', { fileType: 'csv', size: TEXT_MAX_BYTES + 1 }))).toBe('none');
    expect(previewKind({ ...file('Docs'), kind: 'folder' })).toBe('none');
  });
});

describe('downloadUrl', () => {
  it('adds the download flag to the asset URL', () => {
    expect(downloadUrl(file('a b.txt', { assetUrl: '/app/demo-assets/a%20b.txt' }))).toBe('/app/demo-assets/a%20b.txt?download=1');
    expect(downloadUrl(file('a.txt', { assetUrl: undefined }))).toBeUndefined();
  });
});

describe('splitLines', () => {
  it('splits on any newline and drops a single trailing one', () => {
    expect(splitLines('a\nb\r\nc\rd\n')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual(['']);
  });
});

describe('parseCsv', () => {
  it('reads plain and quoted fields', () => {
    expect(parseCsv('id,name\n1,Ann\n2,"Lee, Bo"\n3,"say ""hi"""\n')).toEqual([
      ['id', 'name'],
      ['1', 'Ann'],
      ['2', 'Lee, Bo'],
      ['3', 'say "hi"'],
    ]);
  });

  it('keeps newlines inside quotes, skips blank lines and caps the rows', () => {
    expect(parseCsv('a,b\r\n"x\ny",1\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x\ny', '1'],
    ]);
    const many = ['h'].concat(Array.from({ length: CSV_MAX_ROWS + 50 }, (_, i) => String(i))).join('\n');
    const rows = parseCsv(many);
    expect(rows).toHaveLength(CSV_MAX_ROWS + 1);
    expect(rows.at(-1)).toEqual([String(CSV_MAX_ROWS - 1)]);
    expect(parseCsv('h\n1\n2\n3', 2)).toEqual([['h'], ['1'], ['2']]);
  });
});

describe('previewList', () => {
  const folder = { ...file('Docs'), kind: 'folder' } as Node;
  const listing = [folder, file('b.txt'), file('a.txt'), file('c.txt')];

  it('walks the files of the listing in its order, skipping folders', () => {
    expect(previewList(listing, listing[2])).toEqual({ nodes: [listing[1], listing[2], listing[3]], index: 1 });
    expect(previewList(listing, listing[1]).index).toBe(0);
  });

  it('falls back to the node alone when it is not part of the listing', () => {
    const lone = file('z.txt');
    expect(previewList(listing, lone)).toEqual({ nodes: [lone], index: 0 });
    expect(previewList([], lone)).toEqual({ nodes: [lone], index: 0 });
  });
});
