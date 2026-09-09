import type { Node } from '@/data/types';

/** How the preview modal renders a file; `none` shows the "No preview available" card. */
export type PreviewKind = 'image' | 'video' | 'pdf' | 'text' | 'csv' | 'none';

/** Text-like files are fetched and shown in a <pre>; larger ones fall back to the download card. */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** A CSV preview shows the header and at most this many data rows. */
export const CSV_MAX_ROWS = 200;

const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'yaml',
  'yml',
  'xml',
  'ics',
  'vcf',
  'ts',
  'js',
  'py',
  'go',
  'css',
  'html',
  'sql',
  'sh',
  'dockerfile',
  'toml',
  'env',
  'log',
]);

/** Lower-case extension; an extension-less name (Dockerfile) is its own extension, a dotfile (.env) has its name as one. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot === -1 ? name : name.slice(dot + 1)).toLowerCase();
}

export function previewKind(node: Node): PreviewKind {
  if (node.kind !== 'file' || !node.assetUrl) return 'none';
  switch (node.fileType) {
    case 'image':
      return 'image';
    case 'mp4':
      return 'video';
    case 'pdf':
      return 'pdf';
  }
  const ext = extensionOf(node.name);
  if (ext === 'csv') return node.size <= TEXT_MAX_BYTES ? 'csv' : 'none';
  return TEXT_EXTENSIONS.has(ext) && node.size <= TEXT_MAX_BYTES ? 'text' : 'none';
}

/** Lines of a text file; a single trailing newline does not add an empty last line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Minimal CSV parser (RFC 4180 quoting: quoted fields may hold commas, newlines and doubled quotes). Returns the
 * rows as string arrays, at most `maxRows` after the header row; blank lines are skipped.
 */
export function parseCsv(text: string, maxRows = CSV_MAX_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
    // Header plus `maxRows` rows are in; the rest of the file is not parsed.
    if (rows.length > maxRows) return rows.slice(0, maxRows + 1);
  }
  if (field !== '' || row.length) endRow();
  return rows.slice(0, maxRows + 1);
}

/**
 * The files the preview's ← → walk: the files of `listing` in its current order when `node` is one of them,
 * else just the node (search results, Home, assistant cards). Folders never take part.
 */
export function previewList(listing: Node[], node: Node): { nodes: Node[]; index: number } {
  const files = listing.filter((n) => n.kind === 'file');
  const index = files.findIndex((n) => n.id === node.id);
  return index === -1 ? { nodes: [node], index: 0 } : { nodes: files, index };
}
