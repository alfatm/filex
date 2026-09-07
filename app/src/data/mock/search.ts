import { joinPath, segments } from '@/lib/path';
import type { FileType, FileTypeGroup, MatchRange, Node, SearchHit, SearchQuery, SearchResult } from '../types';
import { contentIndex, indexedOnly, live, nodes, rootNode, storages } from './dataset';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const DAY = 24 * 60 * 60 * 1000;

const UNIT_BYTES = { KB, MB, GB } as const;
const MODIFIED_WINDOW_DAYS = { today: 1, week: 7, month: 30, year: 365 } as const;
const SIZE_PRESET_BYTES = { small: [0, MB], medium: [MB, 100 * MB], large: [100 * MB, Infinity] } as const;
const TYPE_GROUPS: Record<Exclude<FileTypeGroup, 'any'>, FileType[]> = {
  documents: ['md', 'pdf'],
  images: ['image'],
  videos: ['mp4'],
  code: ['ts'],
  spreadsheets: ['csv'],
  design: ['fig'],
};

/** Indexed text is up to 2 KB; a hit shows this many characters around the first match. */
const SNIPPET_CHARS = 120;
const SNIPPET_LEAD = 40;

const storageId = storages.find((s) => s.rootId === rootNode.id)!.id;

/** Folder chain below the storage root, "" for direct children of the root. */
function folderPath(node: Node): string {
  const segments: string[] = [];
  let current = node;
  while (current.parentId !== null && current.parentId !== rootNode.id) {
    current = nodes.find((n) => n.id === current.parentId)!;
    segments.unshift(current.name);
  }
  return segments.join('/');
}

function fold(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.toLowerCase();
}

function ranges(text: string, terms: string[], caseSensitive: boolean): MatchRange[] {
  const haystack = fold(text, caseSensitive);
  const found: MatchRange[] = [];
  for (const term of terms) {
    const needle = fold(term, caseSensitive);
    if (!needle) continue;
    let from = 0;
    for (let at = haystack.indexOf(needle, from); at !== -1; at = haystack.indexOf(needle, from)) {
      found.push({ start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** "… <window of the text around the first highlighted term> …" with the highlight ranges inside it. */
function snippetOf(text: string, highlight: string[], caseSensitive: boolean): { text: string; ranges: MatchRange[] } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = ranges(flat, highlight, caseSensitive)[0]?.start ?? 0;
  let start = Math.min(Math.max(0, first - SNIPPET_LEAD), Math.max(0, flat.length - SNIPPET_CHARS));
  // Open on a word boundary rather than mid-word.
  if (start > 0) start = flat.indexOf(' ', start) + 1 || start;
  const shown = `… ${flat.slice(start, start + SNIPPET_CHARS)} …`;
  return { text: shown, ranges: ranges(shown, highlight, caseSensitive) };
}

export function search(query: SearchQuery, now = Date.now()): SearchResult {
  // Whole-phrase keeps the text as one term; otherwise every word must be found somewhere.
  const terms = query.wholePhrase ? [query.text.trim()].filter(Boolean) : query.text.split(/\s+/).filter(Boolean);
  const matchesText = (value: string) => terms.every((term) => fold(value, query.caseSensitive).includes(fold(term, query.caseSensitive)));
  const pathFilter = query.path.trim().replace(/\/+$/, '').toLowerCase();
  const tagsWanted = query.tags.map((t) => t.toLowerCase());
  const scopeRoot = `/${joinPath([rootNode.name, ...segments(query.folderPath)])}/`.toLowerCase();

  const hits: SearchHit[] = [];
  // Dataset order, with the Design folder's indexed children right after it so the reference rows come first.
  const designAt = nodes.findIndex((n) => n.id === 'design') + 1;
  const index = [...nodes.slice(0, designAt), ...indexedOnly, ...nodes.slice(designAt)];
  for (const node of index) {
    if (node.parentId === null || !live(node)) continue;
    const folder = folderPath(node);
    const folderAbs = `/${joinPath([rootNode.name, ...segments(folder)])}`;
    const fullPath = `${folderAbs}/${node.name}`;
    const content = contentIndex[node.id];
    const contentText = content && (!content.ocr || query.ocr) ? content.text : null;
    const tags = (node.tags ?? []).map((t) => t.toLowerCase());

    if (query.searchIn === 'shared' && !node.shared) continue;
    if (query.searchIn === 'current' && !`${folderAbs.toLowerCase()}/`.startsWith(scopeRoot)) continue;
    if (pathFilter && !fullPath.toLowerCase().startsWith(pathFilter)) continue;
    if (tagsWanted.length && !tagsWanted.every((t) => tags.includes(t))) continue;
    if (query.ownerId && node.ownerId !== query.ownerId) continue;
    if (query.fileType !== 'any' && (node.kind !== 'file' || !TYPE_GROUPS[query.fileType].includes(node.fileType ?? 'other'))) continue;
    if (query.modified !== 'any' && now - Date.parse(node.modifiedAt) > MODIFIED_WINDOW_DAYS[query.modified] * DAY) continue;
    if (query.size.preset !== 'any') {
      if (node.kind !== 'file') continue;
      const unit = UNIT_BYTES[query.size.unit];
      const [min, max] =
        query.size.preset === 'custom'
          ? [(query.size.min ?? 0) * unit, query.size.max === null ? Infinity : query.size.max * unit]
          : SIZE_PRESET_BYTES[query.size.preset];
      if (node.size < min || node.size > max) continue;
    }

    if (terms.length) {
      const matched =
        (query.scope === 'all' && [node.name, fullPath, ...tags, contentText ?? ''].some(matchesText)) ||
        (query.scope === 'content' && contentText !== null && matchesText(contentText)) ||
        (query.scope === 'paths' && matchesText(fullPath)) ||
        (query.scope === 'tags' && tags.some(matchesText));
      if (!matched) continue;
    }

    // Highlight the typed words and the selected tags, so a tag-only query still shows why a row matched.
    const highlight = [...terms, ...query.tags];
    const snippet =
      contentText !== null && (query.scope === 'all' || query.scope === 'content') ? snippetOf(contentText, highlight, query.caseSensitive) : undefined;
    hits.push({ node, storageId, folderPath: folder, snippet });
  }
  return { hits, total: hits.length };
}
