import type { FileType, FileTypeGroup, ListingFilter, Node } from './types';

/**
 * The chips above a listing, as a predicate. The server applies the same rules to every listing it answers; this
 * copy is for the files store, which holds a small folder whole and sieves it here rather than asking again per chip.
 */

const KB = 1024;
const MB = KB * 1024;
const DAY = 24 * 60 * 60 * 1000;

export const MODIFIED_WINDOW_DAYS = { today: 1, week: 7, month: 30, year: 365 } as const;
export const SIZE_PRESET_BYTES = { small: [0, MB], medium: [MB, 100 * MB], large: [100 * MB, Infinity] } as const;
export const TYPE_GROUPS: Record<Exclude<FileTypeGroup, 'any'>, FileType[]> = {
  documents: ['md', 'pdf'],
  images: ['image'],
  videos: ['mp4'],
  code: ['ts'],
  spreadsheets: ['csv'],
  design: ['fig'],
};

/**
 * The chips above a listing, applied where the server would apply them. Type and size are properties of files, so
 * either narrows the listing to files; Modified and People also keep folders.
 */
export function matchesFilter(node: Node, filter: ListingFilter, now = Date.now()): boolean {
  if (filter.fileType !== 'any' && (node.kind !== 'file' || !TYPE_GROUPS[filter.fileType].includes(node.fileType ?? 'other'))) return false;
  // A node with no date can never be inside a "modified in the last N days" window.
  if (filter.modified !== 'any' && (!node.modifiedAt || now - Date.parse(node.modifiedAt) > MODIFIED_WINDOW_DAYS[filter.modified] * DAY)) return false;
  if (filter.size !== 'any') {
    if (node.kind !== 'file') return false;
    const [min, max] = SIZE_PRESET_BYTES[filter.size];
    if (node.size < min || node.size > max) return false;
  }
  if (filter.personId && node.ownerId !== filter.personId) return false;
  const name = filter.name.trim().toLowerCase();
  if (name && !node.name.toLowerCase().includes(name)) return false;
  return true;
}
