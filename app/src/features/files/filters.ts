import type { ListingFilter } from '@/data/types';

/** Filter chips above the listings (spec §3): pill widths at the reference size, before a value is chosen. */
export type FilterId = 'type' | 'people' | 'modified' | 'size';
export const FILTER_WIDTHS: Record<FilterId, number> = { type: 94, people: 106, modified: 120, size: 92 };

export function emptyFilter(): ListingFilter {
  return { fileType: 'any', modified: 'any', size: 'any', personId: null };
}

export function isFiltered(filter: ListingFilter): boolean {
  return filter.fileType !== 'any' || filter.modified !== 'any' || filter.size !== 'any' || filter.personId !== null;
}
