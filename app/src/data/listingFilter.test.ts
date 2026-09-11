import { describe, expect, it } from 'vitest';
import { emptyFilter } from '@/features/files/filters';
import { matchesFilter } from './listingFilter';
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
