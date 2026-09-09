import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The demo tree the app's mock repository is built from, so the counts in `tests/app/` are DERIVED instead of
 * pinned.
 *
 * `app/src/data/mock/tree.json` is a generated snapshot of a demo asset directory that lives in a sibling
 * repository (app/docs/DEMO-ASSETS.md). Regenerating it has already added one file at the root, and every "9
 * files", "17 rows", "8 items" and "14 matching items" that had been typed into a spec went red with it — the
 * suite was reporting a data change as a product failure. Counting from the same file the app reads makes a
 * regenerated tree a data change again.
 *
 * ⚠ Only the tree is here. Dates, stars, tags and the quota are mock ANNOTATIONS on top of it
 * (`REF_OVERRIDES` / `sharedWithMe` in `app/src/data/mock/dataset.ts`) and do not move when the assets are
 * regenerated, so specs keep asserting those literally.
 */

const TREE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/src/data/mock/tree.json');

/** One entry of tree.json, the snapshot `app/scripts/gen-demo-tree.mjs` takes of the demo asset directory. */
export interface TreeEntry {
  path: string;
  kind: 'file' | 'folder';
  size: number;
  mtime: string;
  mime: string;
  /** First 2 KB of text-like files; what the demo search matches on besides the path. */
  text?: string;
}

export const entries: TreeEntry[] = JSON.parse(readFileSync(TREE_JSON, 'utf8')) as TreeEntry[];

/** Entries directly inside `folder`; `''` is the drive root. */
export function childrenOf(folder = ''): TreeEntry[] {
  const prefix = folder ? `${folder}/` : '';
  return entries.filter((e) => e.path.slice(0, e.path.lastIndexOf('/') + 1) === prefix);
}

/** How many rows a listing of `folder` shows — all of them, or only the folders / only the files. */
export function countIn(folder = '', kind?: TreeEntry['kind']): number {
  return childrenOf(folder).filter((e) => !kind || e.kind === kind).length;
}

/**
 * The files the Images type filter keeps, and the ones that paint the served file rather than a placeholder.
 * Extension, not mime: `fileTypeOf` in `app/src/data/fileTypes.ts` decides by extension, which is why a
 * `image/vnd.adobe.photoshop` .psd is not one of these.
 */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

export function imagesIn(folder = ''): TreeEntry[] {
  return childrenOf(folder).filter((e) => e.kind === 'file' && IMAGE_EXTENSIONS.includes(e.path.split('.').pop()?.toLowerCase() ?? ''));
}

/**
 * Nodes the mock puts in the index without putting them in a listing: the two reference search hits inside
 * /demo/Design, and the three shared-with-me rows. `indexedOnly` / `sharedWithMe` in `dataset.ts`.
 */
const EXTRA_INDEXED: { path: string; text?: string }[] = [
  { path: 'Design/overview.pdf', text: 'product design guidelines and brand assets' },
  { path: 'Design/beach.png', text: 'summer campaign design concept' },
  { path: 'Shared/Q3 report.pdf' },
  { path: 'Shared/Brand assets' },
  { path: 'Shared/Roadmap.md' },
];

/**
 * How many rows an advanced search for `text` returns over the whole drive with every other field left neutral.
 *
 * The demo index (`app/src/data/mock/search.ts`) matches a term against the node's name, its full path and its
 * indexed text; tags are not modelled here because no spec searches by tag, and every tag in the dataset sits on
 * a node whose path already carries the word.
 */
export function searchHits(text: string): number {
  const term = text.toLowerCase();
  const matches = (e: { path: string; text?: string }) =>
    `/demo/${e.path}`.toLowerCase().includes(term) || (e.text ?? '').toLowerCase().includes(term);
  return entries.filter(matches).length + EXTRA_INDEXED.filter(matches).length;
}
