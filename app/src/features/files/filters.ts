/** Filter chips above the listings (spec §3): pill widths at the reference size. Inert until filtering lands. */
export type FilterId = 'type' | 'people' | 'modified' | 'size';
export const FILTER_WIDTHS: Record<FilterId, number> = { type: 94, people: 106, modified: 120, size: 92 };
