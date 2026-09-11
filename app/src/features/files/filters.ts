import type { ListingFilter } from '@/data/types';

/** Filter chips above the listings (spec §3): chip widths at the reference size, before a value is chosen. */
export type FilterId = 'type' | 'people' | 'modified' | 'size';
export const FILTER_WIDTHS: Record<FilterId, number> = { type: 76, people: 86, modified: 96, size: 74 };

export function emptyFilter(): ListingFilter {
  return { fileType: 'any', modified: 'any', size: 'any', personId: null, name: '', mime: '', tags: [], around: null };
}

export function isFiltered(filter: ListingFilter): boolean {
  return (
    filter.fileType !== 'any' ||
    filter.modified !== 'any' ||
    filter.size !== 'any' ||
    filter.personId !== null ||
    filter.name.trim() !== '' ||
    filter.mime !== '' ||
    filter.tags.length > 0 ||
    filter.around !== null
  );
}
