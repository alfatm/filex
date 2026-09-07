import type { FileType, ThumbnailKind } from './types';

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

/** Placeholder artwork per type; images carry the real file in `assetUrl` and fall back to the mountain. */
export const TYPE_THUMBNAILS: Partial<Record<FileType, ThumbnailKind>> = {
  md: 'document',
  ts: 'code',
  pdf: 'pdf',
  fig: 'figma',
  csv: 'spreadsheet',
  mp4: 'video',
};

export function fileTypeOf(name: string): FileType {
  return EXTENSION_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'other';
}
