import { joinPath, segments } from '@/lib/path';
import { MODIFIED_WINDOW_DAYS, SIZE_PRESET_BYTES, TYPE_GROUPS } from '../listingFilter';

export { matchesFilter } from '../listingFilter';
import type { MatchRange, Node, SearchHit, SearchQuery, SearchResult } from '../types';
import { contentIndex, indexedOnly, live, nodes, rootNode, storages } from './dataset';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const DAY = 24 * 60 * 60 * 1000;

const UNIT_BYTES = { KB, MB, GB } as const;

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

/** Case is folded away everywhere, exactly as the server's index does it: it lowercases every token it stores. */
function fold(text: string): string {
  return text.toLowerCase();
}

function ranges(text: string, terms: string[]): MatchRange[] {
  const haystack = fold(text);
  const found: MatchRange[] = [];
  for (const term of terms) {
    const needle = fold(term);
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
function snippetOf(text: string, highlight: string[]): { text: string; ranges: MatchRange[] } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = ranges(flat, highlight)[0]?.start ?? 0;
  let start = Math.min(Math.max(0, first - SNIPPET_LEAD), Math.max(0, flat.length - SNIPPET_CHARS));
  // Open on a word boundary rather than mid-word.
  if (start > 0) start = flat.indexOf(' ', start) + 1 || start;
  const shown = `… ${flat.slice(start, start + SNIPPET_CHARS)} …`;
  return { text: shown, ranges: ranges(shown, highlight) };
}

export function search(query: SearchQuery, now = Date.now()): SearchResult {
  // Whole-phrase keeps the text as one term; otherwise every word must be found somewhere.
  const terms = query.wholePhrase ? [query.text.trim()].filter(Boolean) : query.text.split(/\s+/).filter(Boolean);
  const matchesText = (value: string) => terms.every((term) => fold(value).includes(fold(term)));
  // A subtree, not a raw string prefix — the same thing the server's `path_prefix` means, so the demo and a real
  // install answer the Path box alike. `/demo/design` is "inside Design"; it is not "anything starting with those
  // letters", which would also match a sibling called `Designs`.
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
    const contentText = content ? content.text : null;
    const tags = (node.tags ?? []).map((t) => t.toLowerCase());

    if (query.searchIn === 'shared' && !node.shared) continue;
    if (query.searchIn === 'current' && !`${folderAbs.toLowerCase()}/`.startsWith(scopeRoot)) continue;
    if (pathFilter && !inSubtree(fullPath.toLowerCase(), pathFilter)) continue;
    if (tagsWanted.length && !tagsWanted.every((t) => tags.includes(t))) continue;
    if (query.ownerId && node.ownerId !== query.ownerId) continue;
    if (query.fileType !== 'any' && (node.kind !== 'file' || !TYPE_GROUPS[query.fileType].includes(node.fileType ?? 'other'))) continue;
    if (query.modified !== 'any' && (!node.modifiedAt || now - Date.parse(node.modifiedAt) > MODIFIED_WINDOW_DAYS[query.modified] * DAY)) continue;
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
      contentText !== null && (query.scope === 'all' || query.scope === 'content') ? snippetOf(contentText, highlight) : undefined;
    hits.push({ node, storageId, folderPath: folder, snippet });
  }
  // No limit here, so nothing is ever cut off: the mock's answer is always the whole answer.
  return { hits, total: hits.length, capped: false };
}

/** Whether `path` is `prefix` itself or something inside it. Segment-wise, so `/a/bc` is not inside `/a/b`. */
function inSubtree(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
