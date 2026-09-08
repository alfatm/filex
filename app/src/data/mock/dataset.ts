import type { Node, NodeKind, Person, Storage, User } from '../types';
import tree from './tree.json';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const ROOT_ID = 'demo';

export const user: User = { id: 'demo', name: 'demo', initial: 'D', email: 'demo@filex.local', role: 'owner', fullName: 'demo' };

export const storages: Storage[] = [
  { id: 'demo', name: 'demo', rootId: ROOT_ID, quota: { usedBytes: 12.4 * GB, totalBytes: 100 * GB } },
];

/** One entry of tree.json, the snapshot `scripts/gen-demo-tree.mjs` takes of the demo asset directory. */
interface TreeEntry {
  path: string;
  kind: NodeKind;
  size: number;
  mtime: string;
  mime: string;
  /** First 2 KB of text-like files; feeds `contentIndex`. */
  text?: string;
}

export { fileTypeOf, TYPE_THUMBNAILS } from '../fileTypes';
import { fileTypeOf, TYPE_THUMBNAILS } from '../fileTypes';

/** The dev server / build ship every file under demo-assets/ (see vite.config.ts). */
function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}demo-assets/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** "Design/Brand Guidelines.pdf" → "design/brand-guidelines-pdf"; the same slug `newId` in index.ts builds. */
function idOf(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9/]+/g, '-');
}

const DESIGN_TAGS = ['design', 'project alpha'];

/**
 * Spec §8: the 16 root entries keep the reference dates, sizes and annotations so the screenshots stay put
 * (mountains.jpg is 246 KB on disk, the ref shows 12 MB). Everything below the root uses the real size and a
 * date derived from its parent's (see `derivedDate`). The order is the reference order of the dataset.
 */
const REF_OVERRIDES: Record<string, Partial<Pick<Node, 'modifiedAt' | 'size' | 'tags' | 'starred' | 'shared' | 'thumbnail' | 'duration'>>> = {
  Code: { modifiedAt: '2026-07-08T11:24:00' },
  Design: { modifiedAt: '2026-07-01T09:12:00', tags: DESIGN_TAGS },
  Documents: { modifiedAt: '2026-06-28T15:45:00' },
  Photos: { modifiedAt: '2026-06-20T10:11:00', starred: true },
  example: { modifiedAt: '2026-06-18T14:34:00' },
  Archive: { modifiedAt: '2026-06-14T13:20:00' },
  Resources: { modifiedAt: '2026-06-10T16:18:00' },
  Shared: { modifiedAt: '2026-06-05T11:03:00', shared: true },
  'README.md': { modifiedAt: '2026-07-10T12:06:00', size: 2.4 * KB },
  'mountains.jpg': { modifiedAt: '2026-07-09T09:26:00', size: 12 * MB, starred: true },
  'app.ts': { modifiedAt: '2026-07-08T15:14:00', size: 4.8 * KB },
  'overview.pdf': { modifiedAt: '2026-07-07T11:22:00', size: 2.1 * MB },
  'beach.png': { modifiedAt: '2026-07-06T14:17:00', size: 3.4 * MB, thumbnail: 'beach' },
  'UI Design.fig': { modifiedAt: '2026-07-05T10:08:00', size: 12.6 * MB, starred: true },
  'data.csv': { modifiedAt: '2026-07-05T09:41:00', size: 568 * KB },
  'demo.mp4': { modifiedAt: '2026-07-03T16:55:00', size: 24.8 * MB, duration: '02:14' },
};

/** Local wall-clock ISO without zone, the form the reference dates use. */
function localIso(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Children are dated one hour apart below their parent, so Recent's day groups stay deterministic. */
function derivedDate(parentModifiedAt: string, index: number): string {
  return localIso(Date.parse(parentModifiedAt) - (index + 1) * HOUR);
}

const entries = tree as TreeEntry[];
const isRootEntry = (e: TreeEntry) => !e.path.includes('/');

export const rootNode: Node = {
  id: ROOT_ID,
  name: 'demo',
  kind: 'folder',
  parentId: null,
  size: 0,
  modifiedAt: '2026-07-10T12:06:00',
  createdAt: '2026-06-01T09:00:00',
  ownerId: user.id,
  itemCount: entries.filter(isRootEntry).length,
  shared: false,
  starred: false,
};

/** Nodes for every tree entry: the root entries first in reference order, then the nested ones in tree order. */
function buildTree(): Node[] {
  const byPath = new Map<string, Node>();
  const childrenOf = (path: string) => entries.filter((e) => e.path.slice(0, e.path.lastIndexOf('/') + 1) === (path ? `${path}/` : ''));
  const build = (entry: TreeEntry): Node => {
    const at = entry.path.lastIndexOf('/');
    const name = entry.path.slice(at + 1);
    const parentPath = at === -1 ? '' : entry.path.slice(0, at);
    const parent = at === -1 ? rootNode : byPath.get(parentPath)!;
    const ref = at === -1 ? REF_OVERRIDES[name] : undefined;
    const modifiedAt = ref?.modifiedAt ?? derivedDate(parent.modifiedAt ?? '', childrenOf(parentPath).indexOf(entry));
    const fileType = entry.kind === 'file' ? fileTypeOf(name) : undefined;
    const thumbnail = fileType && (fileType === 'image' ? 'mountain' : TYPE_THUMBNAILS[fileType]);
    const node: Node = {
      id: idOf(entry.path),
      name,
      kind: entry.kind,
      parentId: parent.id,
      size: entry.size,
      modifiedAt,
      createdAt: modifiedAt,
      ownerId: user.id,
      shared: false,
      starred: false,
      ...(entry.kind === 'folder' && { itemCount: childrenOf(entry.path).length }),
      ...(fileType && { fileType }),
      ...(thumbnail && { thumbnail }),
      ...(entry.kind === 'file' && { assetUrl: assetUrl(entry.path) }),
      ...ref,
    };
    byPath.set(entry.path, node);
    return node;
  };
  // Root entries first so the reference search rows precede the nested ones; unknown names keep the tree order.
  const roots = entries.filter(isRootEntry);
  const order = Object.keys(REF_OVERRIDES);
  const rank = (e: TreeEntry) => (order.includes(e.path) ? order.indexOf(e.path) : order.length + roots.indexOf(e));
  const sortedRoots = [...roots].sort((a, b) => rank(a) - rank(b));
  // tree.json lists a folder before its content, so every parent is built before its children.
  return [...sortedRoots.map(build), ...entries.filter((e) => !isRootEntry(e)).map(build)];
}

/**
 * Shared-with-me nodes live inside /demo/Shared and are dated relative to "now" so the Recent page shows its
 * "Today" / "Yesterday" groups. Not `shared: true` — that flag means shared *by* the user (search's "Shared files").
 * They are mock annotations on top of the asset tree, so the Shared folder's item count does not include them.
 */
function sharedWithMe(now = Date.now()): Node[] {
  const alice = { ownerId: 'alice', ownerName: 'Alice Johnson', sharedBy: 'Alice Johnson' };
  const marcus = { ownerId: 'marcus', ownerName: 'Marcus Lee', sharedBy: 'Marcus Lee' };
  const at = (ms: number) => new Date(now - ms).toISOString();
  return [
    {
      id: 'shared/q3-report-pdf',
      name: 'Q3 report.pdf',
      kind: 'file',
      parentId: 'shared',
      size: 1.8 * MB,
      modifiedAt: at(2 * HOUR),
      createdAt: at(3 * DAY),
      fileType: 'pdf',
      thumbnail: 'pdf',
      shared: false,
      starred: false,
      sharedAt: at(2 * HOUR),
      ...alice,
    },
    {
      id: 'shared/brand-assets',
      name: 'Brand assets',
      kind: 'folder',
      parentId: 'shared',
      size: 0,
      modifiedAt: at(4 * DAY + 3 * HOUR),
      createdAt: at(10 * DAY),
      itemCount: 14,
      shared: false,
      starred: false,
      sharedAt: at(4 * DAY + 3 * HOUR),
      ...marcus,
    },
    {
      id: 'shared/roadmap-md',
      name: 'Roadmap.md',
      kind: 'file',
      parentId: 'shared',
      size: 6.2 * KB,
      modifiedAt: at(DAY + 5 * HOUR),
      createdAt: at(12 * DAY),
      fileType: 'md',
      thumbnail: 'document',
      shared: false,
      starred: false,
      sharedAt: at(DAY + 5 * HOUR),
      ...alice,
    },
  ];
}

const treeNodes = buildTree();
const rootCount = rootNode.itemCount!;

export const nodes: Node[] = [rootNode, ...treeNodes.slice(0, rootCount), ...sharedWithMe(), ...treeNodes.slice(rootCount)];

/**
 * A node counts as trashed when it or any ancestor is: children of a trashed folder disappear from every listing.
 * A missing parent (deleted forever) hides the node as well.
 */
export function live(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (current.deletedAt) return false;
    if (current.parentId === null) return true;
    const parentId: string = current.parentId;
    current = nodes.find((n) => n.id === parentId);
  }
  return false;
}

/**
 * Reachable through search only: the reference search hits (spec §5) are an overview.pdf and a beach.png inside
 * /demo/Design, which the asset tree does not have (its Design folder holds the 8 mockups). They stay out of the
 * folder listing so "Design 8 items" holds; beach.png borrows the root photo for its thumbnail.
 */
export const indexedOnly: Node[] = [
  {
    ...treeNodes.find((n) => n.id === 'overview-pdf')!,
    id: 'design/overview-pdf',
    parentId: 'design',
    tags: DESIGN_TAGS,
  },
  {
    ...treeNodes.find((n) => n.id === 'beach-png')!,
    id: 'design/beach-png',
    parentId: 'design',
    tags: DESIGN_TAGS,
  },
];

export const people: Person[] = [{ id: user.id, name: user.name, initial: user.initial, role: 'owner' }];

/**
 * Options of the People chip: the user, then everyone else who owns something they can see. The server will answer
 * this from its permission tables; here it is derived from the nodes themselves.
 */
export function filterPeople(): Person[] {
  const others = new Map<string, string>();
  for (const node of nodes) {
    if (node.ownerId !== user.id && live(node)) others.set(node.ownerId, node.ownerName ?? node.ownerId);
  }
  return [
    ...people,
    ...[...others].map(([id, name]) => ({ id, name, initial: name.charAt(0), role: 'editor' as const })),
  ];
}

/** Indexed text per node id; `ocr` marks text recognised from images/scans (searched only when the query asks for OCR). */
export const contentIndex: Record<string, { text: string; ocr?: boolean }> = {
  ...Object.fromEntries(entries.filter((e) => e.text).map((e) => [idOf(e.path), { text: e.text! }])),
  'design/overview-pdf': { text: 'product design guidelines and brand assets' },
  'design/beach-png': { text: 'summer campaign design concept', ocr: true },
};
