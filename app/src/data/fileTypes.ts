import type { FileType, Node, ThumbnailKind } from './types';

/** Name → type → placeholder artwork. Shared by the mock and the HTTP mapper: neither owns what a ".csv" is. */
const EXTENSION_TYPES: Record<string, FileType> = {
  md: 'md',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  ts: 'ts',
  pdf: 'pdf',
  fig: 'fig',
  csv: 'csv',
  mp4: 'mp4',
};

/** Placeholder artwork per type; an image paints its `thumbUrl` and falls back to the mountain. */
export const TYPE_THUMBNAILS: Partial<Record<FileType, ThumbnailKind>> = {
  image: 'mountain',
  md: 'document',
  ts: 'code',
  pdf: 'pdf',
  fig: 'figma',
  csv: 'spreadsheet',
  mp4: 'video',
};

/**
 * The i18n key that names a node's type: what the listing's Type column prints and what a sort by type orders by.
 * A folder is a type of its own here — it is what the column has to say about one, and grouping puts them together
 * at one end regardless.
 */
export function typeKeyOf(node: Node): string {
  return `type.${node.kind === 'folder' ? 'folder' : (node.fileType ?? 'other')}`;
}

export function fileTypeOf(name: string): FileType {
  return EXTENSION_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'other';
}

/**
 * The extensions that make up a set of types — the same table read backwards.
 *
 * It exists because the server filters by extension and nothing else: which extensions count as "documents" is a
 * decision this file makes, and a second copy of it in Go would be a second copy to keep in step. The client sends
 * the list it means, so there is only ever one taxonomy.
 */
export function extensionsOf(types: readonly FileType[]): string[] {
  return Object.entries(EXTENSION_TYPES)
    .filter(([, type]) => types.includes(type))
    .map(([ext]) => ext);
}
