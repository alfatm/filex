import { describe, expect, it } from 'vitest';
import type { Node, SearchHit } from '@/data/types';
import { emptyQuery } from '@/features/search/searchStore';
import { pageContext, searchFilters } from './context';

const node = (id: string) => ({ id, name: id.split('/').pop() ?? id, kind: 'file' } as Node);
const hit = (id: string) => ({ node: node(id), storageId: 'main', folderPath: '' } as SearchHit);
const noSearch = { query: emptyQuery(), hits: [], total: 0, capped: false };

describe('pageContext', () => {
  it('names the open folder and the selection on the folder page', () => {
    const files = { folder: node('main://Design'), selected: [node('main://Design/a.pdf'), node('main://Design/b.pdf')] };
    expect(pageContext('files', files, noSearch)).toEqual({
      page: 'folder',
      folder: 'main://Design',
      selected: ['main://Design/a.pdf', 'main://Design/b.pdf'],
    });
  });

  it('carries the query, the settings that differ from a fresh search, the count and the first hits on the search page', () => {
    const query = { ...emptyQuery(), text: 'invoice', fileType: 'documents' as const, modified: 'week' as const };
    const search = { query, hits: [hit('main://Docs/inv-1.pdf'), hit('main://Docs/inv-2.pdf')], total: 120, capped: true };
    expect(pageContext('search', { folder: null, selected: [] }, search)).toEqual({
      page: 'search',
      search: {
        query: 'invoice',
        filters: ['modified: week', 'type: documents'],
        total: 120,
        capped: true,
        hits: ['main://Docs/inv-1.pdf', 'main://Docs/inv-2.pdf'],
      },
    });
  });

  it('caps a large selection and says how many there really are', () => {
    const selected = Array.from({ length: 60 }, (_, i) => node(`main://Docs/f${i}.txt`));
    const context = pageContext('recent', { folder: null, selected }, noSearch);
    expect(context?.page).toBe('recent');
    expect(context?.selected).toHaveLength(50);
    expect(context?.selectedTotal).toBe(60);
  });

  it('sends nothing from a page the assistant has no words for', () => {
    expect(pageContext('apiKeys', { folder: null, selected: [] }, noSearch)).toBeUndefined();
    expect(pageContext(undefined, { folder: null, selected: [] }, noSearch)).toBeUndefined();
  });
});

describe('searchFilters', () => {
  it('is empty for a fresh search', () => {
    expect(searchFilters(emptyQuery())).toEqual([]);
  });

  it('spells the current-folder scope and a custom size range', () => {
    const query = { ...emptyQuery(), folderPath: 'Design/Assets', tags: ['q1', 'final'], wholePhrase: true, size: { preset: 'custom' as const, min: 5, max: null, unit: 'MB' as const } };
    expect(searchFilters(query)).toEqual(['folder: Design/Assets', 'tags: q1, final', 'size: 5– MB', 'whole phrase']);
  });
});
