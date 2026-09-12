import { describe, expect, it } from 'vitest';
import { emptyFilter } from '@/features/files/filters';
import { matchesFilter, sizeBandOf, typeGroupOf } from './listingFilter';
import type { Node } from './types';

const node = (name: string, kind: Node['kind'] = 'file'): Node => ({ id: `main://${name}`, name, kind, parentId: 'main://', size: 1, ownerId: 'u1', shared: false, starred: false });

describe('matchesFilter — the name box', () => {
  it('matches a substring of the name regardless of case, and keeps folders', () => {
    const filter = { ...emptyFilter(), name: 'REP' };
    expect(matchesFilter(node('report.pdf'), filter)).toBe(true);
    expect(matchesFilter(node('Reports', 'folder'), filter)).toBe(true);
    expect(matchesFilter(node('notes.md'), filter)).toBe(false);
  });

  it('reads blank as no name filter at all', () => {
    expect(matchesFilter(node('notes.md'), { ...emptyFilter(), name: '  ' })).toBe(true);
  });
});

describe('matchesFilter — the MIME type the details panel sets', () => {
  const typed = (mime?: string, kind: Node['kind'] = 'file'): Node => ({ ...node('a.png', kind), mime });
  const filter = { ...emptyFilter(), mime: 'image/png' };

  it('keeps the files of exactly that type, whatever case the row spells it in', () => {
    expect(matchesFilter(typed('image/png'), filter)).toBe(true);
    expect(matchesFilter(typed('IMAGE/PNG'), filter)).toBe(true);
    expect(matchesFilter(typed('image/jpeg'), filter)).toBe(false);
  });

  it('drops what cannot answer: a row the server typed nothing for, and every folder', () => {
    expect(matchesFilter(typed(undefined), filter)).toBe(false);
    expect(matchesFilter(typed('image/png', 'folder'), filter)).toBe(false);
  });
});

describe('matchesFilter — the date window the details panel sets', () => {
  const at = '2026-09-09T12:00:00Z';
  const dated = (patch: Partial<Node>): Node => ({ ...node('a.md'), ...patch });

  it('keeps what was written within a day either side, not what shares the calendar day', () => {
    const filter = { ...emptyFilter(), around: { field: 'modified' as const, at, span: 'day' as const } };
    expect(matchesFilter(dated({ modifiedAt: '2026-09-09T23:50:00Z' }), filter)).toBe(true);
    // The next calendar day, twenty-three hours on: still "around the same time".
    expect(matchesFilter(dated({ modifiedAt: '2026-09-10T11:00:00Z' }), filter)).toBe(true);
    expect(matchesFilter(dated({ modifiedAt: '2026-09-10T13:00:00Z' }), filter)).toBe(false);
    expect(matchesFilter(dated({ modifiedAt: '2026-09-08T10:00:00Z' }), filter)).toBe(false);
  });

  it('reads the field the window names, and drops a row that has no such date', () => {
    const created = { ...emptyFilter(), around: { field: 'created' as const, at, span: 'day' as const } };
    expect(matchesFilter(dated({ createdAt: at, modifiedAt: '2020-01-01T00:00:00Z' }), created)).toBe(true);
    // No creation date at all is not a date inside the window.
    expect(matchesFilter(dated({ modifiedAt: at }), created)).toBe(false);
  });

  it('ignores tags, which no listing row carries — the server alone applies them', () => {
    expect(matchesFilter(node('a.md'), { ...emptyFilter(), tags: ['design'] })).toBe(true);
  });
});

describe('the bands a property click asks for', () => {
  it('names the size band a file falls in, as the Size chip spells them', () => {
    expect(sizeBandOf(500)).toBe('small');
    expect(sizeBandOf(50 * 1024 * 1024)).toBe('medium');
    expect(sizeBandOf(500 * 1024 * 1024)).toBe('large');
  });

  it('names the type group, or nothing for a type no group covers', () => {
    expect(typeGroupOf('pdf')).toBe('documents');
    expect(typeGroupOf('image')).toBe('images');
    expect(typeGroupOf('other')).toBeNull();
    expect(typeGroupOf(undefined)).toBeNull();
  });
});

describe('the width of the window', () => {
  it('reads the span the chip carries, not a fixed day', () => {
    const at = '2026-09-09T12:00:00Z';
    const node = (modifiedAt: string): Node => ({ ...({ id: 'main://a.md', name: 'a.md', kind: 'file', parentId: 'main://', size: 1, ownerId: 'u1', shared: false, starred: false } as Node), modifiedAt });
    const hour = { ...emptyFilter(), around: { field: 'modified' as const, at, span: 'hour' as const } };
    const week = { ...emptyFilter(), around: { field: 'modified' as const, at, span: 'week' as const } };

    expect(matchesFilter(node('2026-09-09T12:30:00Z'), hour)).toBe(true);
    expect(matchesFilter(node('2026-09-09T14:00:00Z'), hour)).toBe(false);
    expect(matchesFilter(node('2026-09-14T00:00:00Z'), week)).toBe(true);
    expect(matchesFilter(node('2026-09-20T00:00:00Z'), week)).toBe(false);
  });
});
