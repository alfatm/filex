import { windowBounds } from './dateWindow';
import type { DateWindow, FileType, FileTypeGroup, ListingFilter, Node, SizePreset } from './types';

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

/** The date a window tests, as the node carries it; undefined where the row has none. */
export function dateOf(node: Node, field: DateWindow['field']): string | undefined {
  return field === 'modified' ? node.modifiedAt : node.createdAt;
}

/** Which size band a file falls in — the bands the Size chip offers, so "files about this big" is one of them. */
export function sizeBandOf(bytes: number): Exclude<SizePreset, 'any' | 'custom'> {
  const bands = Object.entries(SIZE_PRESET_BYTES) as [Exclude<SizePreset, 'any' | 'custom'>, readonly [number, number]][];
  return bands.find(([, [min, max]]) => bytes >= min && bytes <= max)?.[0] ?? 'large';
}

/** Which chip group a file type belongs to, or null for a type no group covers. */
export function typeGroupOf(type: FileType | undefined): Exclude<FileTypeGroup, 'any'> | null {
  const entries = Object.entries(TYPE_GROUPS) as [Exclude<FileTypeGroup, 'any'>, FileType[]][];
  return entries.find(([, types]) => types.includes(type ?? 'other'))?.[0] ?? null;
}

/**
 * The chips above a listing, applied where the server would apply them. Type and size are properties of files, so
 * either narrows the listing to files; Modified and People also keep folders.
 *
 * ⚠ Tags are NOT applied here, and cannot be: no listing row carries its tags — they are read per node — so a
 * sieve over the rows would drop every one of them. A tag filter is the server's alone, which is why the store
 * stops holding a folder locally as soon as one is set.
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
  if (filter.around) {
    const at = dateOf(node, filter.around.field);
    if (!at) return false;
    const { after, before } = windowBounds(filter.around);
    const ms = Date.parse(at);
    if (ms < after || ms > before) return false;
  }
  // The type the server recorded, in full: a row it recorded none for cannot answer the question either way.
  if (filter.mime && (node.kind !== 'file' || (node.mime ?? '').toLowerCase() !== filter.mime)) return false;
  if (filter.personId && node.ownerId !== filter.personId) return false;
  const name = filter.name.trim().toLowerCase();
  if (name && !node.name.toLowerCase().includes(name)) return false;
  return true;
}
