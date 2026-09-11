import { describe, expect, it } from 'vitest';
import { emptyFilter } from './filters';
import { fromFilterQuery, toFilterQuery } from './filterQuery';

describe('the filter as an address', () => {
  const filter = {
    ...emptyFilter(),
    fileType: 'images' as const,
    size: 'medium' as const,
    personId: '7',
    tags: ['design', 'q3'],
    around: { field: 'created' as const, at: '2026-09-09T12:00:00Z', span: 'week' as const },
  };

  it('writes only what differs from the neutral filter, and reads it back whole', () => {
    expect(toFilterQuery(emptyFilter())).toEqual({});
    expect(toFilterQuery(filter)).toEqual({
      type: 'images',
      size: 'medium',
      owner: '7',
      tags: ['design', 'q3'],
      date: 'created',
      at: '2026-09-09T12:00:00Z',
      span: 'week',
    });
    expect(fromFilterQuery(toFilterQuery(filter))).toEqual(filter);
  });

  it('leaves the name box out: it is cleared on every navigation, and the address would be a second answer', () => {
    expect(toFilterQuery({ ...emptyFilter(), name: 'rep' })).toEqual({});
  });

  it('reads anything unusable as not set rather than as a filter nothing can satisfy', () => {
    expect(fromFilterQuery({ type: 'sculptures', size: 'custom', modified: 'yesterday' })).toEqual(emptyFilter());
    // Half a window is not a window: the field and the moment both have to be there, and the moment has to parse.
    expect(fromFilterQuery({ date: 'created' }).around).toBeNull();
    expect(fromFilterQuery({ date: 'created', at: 'soon' }).around).toBeNull();
    expect(fromFilterQuery({ at: '2026-09-09T12:00:00Z' }).around).toBeNull();
    // A window with no width is a day wide, which is what a property click sets.
    expect(fromFilterQuery({ date: 'modified', at: '2026-09-09T12:00:00Z' }).around).toEqual({
      field: 'modified',
      at: '2026-09-09T12:00:00Z',
      span: 'day',
    });
  });

  it('folds the tags the way the server stores them, and drops the duplicates', () => {
    expect(fromFilterQuery({ tags: ['Design', ' design ', 'Q3', ''] }).tags).toEqual(['design', 'q3']);
    expect(fromFilterQuery({ tags: 'design' }).tags).toEqual(['design']);
  });
});
