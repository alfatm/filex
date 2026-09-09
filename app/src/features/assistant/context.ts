import type { AssistantContext, AssistantPage, Node, SearchHit, SearchQuery } from '@/data/types';

/** Ceilings on what one question carries; the server clips to the same numbers. */
const MAX_CONTEXT_SELECTED = 50;
const MAX_CONTEXT_HITS = 20;

/** The routes the assistant has a page word for. A question asked anywhere else travels without a context. */
const PAGES: Record<string, AssistantPage> = {
  files: 'folder',
  search: 'search',
  recent: 'recent',
  starred: 'starred',
  shared: 'shared',
  trash: 'trash',
  home: 'home',
};

interface FilesState {
  folder: Node | null;
  selected: Node[];
}

interface SearchState {
  query: SearchQuery;
  hits: SearchHit[];
  total: number;
  capped: boolean;
}

/**
 * What the person is looking at, for the model to read "this folder" and "these files" against.
 *
 * Addresses only: a node's id IS its address (`main://Docs/a.pdf`), so nothing is fetched. The open folder's
 * contents are deliberately not carried — the model has list_folder for that, and a listing pasted into every
 * question would be most of the window.
 */
export function pageContext(routeName: unknown, files: FilesState, search: SearchState): AssistantContext | undefined {
  const page = typeof routeName === 'string' ? PAGES[routeName] : undefined;
  if (!page) return undefined;
  const out: AssistantContext = { page };
  if (page === 'folder' && files.folder) out.folder = files.folder.id;
  if (files.selected.length) {
    out.selected = files.selected.slice(0, MAX_CONTEXT_SELECTED).map((n) => n.id);
    if (files.selected.length > out.selected.length) out.selectedTotal = files.selected.length;
  }
  if (page === 'search') {
    out.search = {
      query: search.query.text,
      filters: searchFilters(search.query),
      total: search.total,
      capped: search.capped,
      hits: search.hits.slice(0, MAX_CONTEXT_HITS).map((hit) => hit.node.id),
    };
  }
  return out;
}

/** The settings that differ from a fresh search, as `name: value` in the form's own vocabulary. */
export function searchFilters(query: SearchQuery): string[] {
  const out: string[] = [];
  if (query.scope !== 'all') out.push(`scope: ${query.scope}`);
  if (query.searchIn !== 'current') out.push(`in: ${query.searchIn}`);
  else if (query.folderPath) out.push(`folder: ${query.folderPath}`);
  if (query.modified !== 'any') out.push(`modified: ${query.modified}`);
  if (query.fileType !== 'any') out.push(`type: ${query.fileType}`);
  if (query.tags.length) out.push(`tags: ${query.tags.join(', ')}`);
  if (query.ownerId) out.push(`owner: ${query.ownerId}`);
  if (query.size.preset === 'custom') out.push(`size: ${query.size.min ?? ''}–${query.size.max ?? ''} ${query.size.unit}`);
  else if (query.size.preset !== 'any') out.push(`size: ${query.size.preset}`);
  if (query.path) out.push(`path: ${query.path}`);
  if (query.wholePhrase) out.push('whole phrase');
  return out;
}
