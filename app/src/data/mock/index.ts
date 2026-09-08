import { segments } from '@/lib/path';
import { DUPLICATE_NAME, MIN_PASSWORD_LENGTH, WRONG_PASSWORD, type Repository } from '../repository';
import type { ListingFilter, Node, NotifyPrefs, Session, User } from '../types';
import { fileTypeOf, filterPeople, indexedOnly, live, nodes, storages, TYPE_THUMBNAILS, user } from './dataset';
import * as history from './history';
import { assistantAsk } from './assistant';
import { matchesFilter, search } from './search';

// `nodes` is the single in-memory state: search reads it too, so mutations edit that array in place.
const initial: Node[] = structuredClone(nodes);
// The account is mutable too — the settings modal edits it — so its starting shape is kept for the reset.
const initialUser: User = { ...user };
let seq = 0;

/** Tests only: puts the dataset back to its initial shape. */
export function resetMock() {
  nodes.splice(0, nodes.length, ...structuredClone(initial));
  Object.assign(user, initialUser);
  history.resetHistory();
  seq = 0;
}

function byId(id: string): Node {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

/** Every listing runs the chips through the same predicate the server would apply. */
const keep = (node: Node, filter?: ListingFilter) => !filter || matchesFilter(node, filter);

/** Callers get copies so the store's reactive proxies never alias mock state. */
const copy = (list: Node[]) => list.map((n) => ({ ...n }));

function absolutePath(id: string): string {
  const names: string[] = [];
  for (let current: Node | null = byId(id); current; current = current.parentId ? byId(current.parentId) : null) {
    names.unshift(current.name);
  }
  return `/${names.join('/')}`;
}

function descendants(id: string): Node[] {
  const out: Node[] = [];
  for (const child of nodes.filter((n) => n.parentId === id)) out.push(child, ...descendants(child.id));
  return out;
}

function bumpItemCount(folderId: string | null, delta: number) {
  if (!folderId) return;
  const folder = byId(folderId);
  folder.itemCount = Math.max(0, (folder.itemCount ?? 0) + delta);
}

/** Sibling with the same name (live only); the modals turn the rejection into an inline error. */
function assertNoSibling(parentId: string | null, name: string, exceptId?: string) {
  if (nodes.some((n) => n.parentId === parentId && n.id !== exceptId && n.name === name && live(n))) throw new Error(DUPLICATE_NAME);
}

/**
 * The name a copy lands under: the server probes the destination and falls back to `<base>-copy<ext>`, then
 * `-copy-2`, so a paste into the source's own folder duplicates instead of colliding (see ops.uniqueCopyDest).
 */
function copyName(parentId: string, name: string): string {
  const taken = (candidate: string) => nodes.some((n) => n.parentId === parentId && n.name === candidate && live(n));
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${stem}-copy${ext}` : `${stem}-copy-${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

function newId(parentId: string, name: string): string {
  const base = `${parentId}/${name}`.toLowerCase().replace(/[^a-z0-9/]+/g, '-');
  return nodes.some((n) => n.id === base) ? `${base}-${++seq}` : base;
}

/**
 * The demo has no network, so a transfer would finish before the tray could draw it. This plays the same shape a
 * staged upload has — a chunk accepted, an offset reported — over MOCK_UPLOAD_MS, so the bar means the same thing
 * in the demo as it does against a server: bytes the far side has taken.
 */
export const MOCK_UPLOAD_MS = 1500;

/** The demo account's current password: what the Security card's form accepts, and what a wrong one is measured against. */
export const MOCK_PASSWORD = 'demo';
const MOCK_UPLOAD_STEPS = 15;

/** The demo account's notification switches, kept where the server would keep them. */
const notify: NotifyPrefs = { shared: true, comments: true, uploads: false };

/**
 * Where the demo account is "signed in". Dated inside the mock tree's own week so the list reads the same on every
 * run, and revoking really removes a row — the Security tab is otherwise a screen that cannot be wrong.
 */
let sessions: Session[] = [
  {
    id: '1',
    ip: '192.168.1.24',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    createdAt: '2026-07-10T08:12:00Z',
    expiresAt: '2026-08-09T08:12:00Z',
    current: true,
  },
  {
    id: '2',
    ip: '192.168.1.31',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    createdAt: '2026-07-08T19:40:00Z',
    expiresAt: '2026-08-07T19:40:00Z',
    current: false,
  },
  {
    id: '3',
    ip: '81.2.69.144',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    createdAt: '2026-07-02T11:05:00Z',
    expiresAt: '2026-08-01T11:05:00Z',
    current: false,
  },
];

function fakeTransfer(size: number, onProgress?: (sent: number, total: number) => void): Promise<void> {
  if (!onProgress) return Promise.resolve();
  return new Promise((resolve) => {
    let step = 0;
    onProgress(0, size);
    const timer = setInterval(() => {
      step += 1;
      onProgress(Math.round((size * step) / MOCK_UPLOAD_STEPS), size);
      if (step < MOCK_UPLOAD_STEPS) return;
      clearInterval(timer);
      resolve();
    }, MOCK_UPLOAD_MS / MOCK_UPLOAD_STEPS);
  });
}

export const mockRepository: Repository = {
  async listStorages() {
    return storages;
  },
  async getStorage(id) {
    const storage = storages.find((s) => s.id === id);
    if (!storage) throw new Error(`storage not found: ${id}`);
    return storage;
  },
  async listFolder(folderId, filter) {
    return copy(nodes.filter((n) => n.parentId === folderId && live(n) && keep(n, filter)));
  },
  async resolvePath(storageId, path) {
    const storage = await this.getStorage(storageId);
    let current = byId(storage.rootId);
    for (const segment of segments(path)) {
      const child = nodes.find((n) => n.parentId === current.id && n.kind === 'folder' && n.name === segment && live(n));
      if (!child) throw new Error(`path not found: ${path}`);
      current = child;
    }
    return { ...current };
  },
  async getNode(id) {
    return { ...byId(id) };
  },
  async getPath(id) {
    const chain: Node[] = [];
    let current = byId(id);
    while (current.parentId !== null) {
      current = byId(current.parentId);
      chain.unshift({ ...current });
    }
    return chain;
  },
  async listPeople(nodeId) {
    // The demo account owns everything it can see, so it may always change the list.
    return { people: history.listAccess(nodeId), canManage: true };
  },
  async addPerson(nodeId, email, role) {
    history.addPerson(nodeId, email, role);
  },
  async setPersonRole(nodeId, personId, role) {
    history.setPersonRole(nodeId, personId, role);
  },
  async removePerson(nodeId, personId) {
    history.removePerson(nodeId, personId);
  },
  async listVersions(nodeId) {
    return history.listVersions(nodeId);
  },
  async restoreVersion(nodeId, versionId) {
    history.restoreVersion(nodeId, versionId);
    history.record(nodeId, 'restored');
  },
  async listActivity(nodeId) {
    return history.listActivity(nodeId);
  },
  async listFilterPeople() {
    return filterPeople();
  },
  async currentUser() {
    return { ...user };
  },
  /** The demo account is edited in place, so the header and the avatar follow the modal as the real one would. */
  async updateProfile(patch) {
    if (patch.name !== undefined) {
      user.name = patch.name;
      user.initial = (patch.name.trim()[0] ?? '?').toUpperCase();
    }
    if (patch.fullName !== undefined) user.fullName = patch.fullName || undefined;
    if (patch.jobTitle !== undefined) user.jobTitle = patch.jobTitle || undefined;
    if (patch.locale !== undefined) user.locale = patch.locale;
    if (patch.timeZone !== undefined) user.timeZone = patch.timeZone;
    if (patch.avatarUrl !== undefined) user.avatarUrl = patch.avatarUrl || undefined;
    return { ...user };
  },
  /** No credential to check against; the demo account accepts any change but still enforces the length rule. */
  archiveUrl() {
    // Zipping is the server's work, and the demo has no server; the capability says so and the UI stays honest.
    return null;
  },
  async authMethods() {
    // The demo signs in the way a single-drive filex install does.
    return { provider: 'local', changePassword: true, totpEnabled: false };
  },
  async notifyPrefs() {
    return { ...notify };
  },
  async saveNotifyPrefs(prefs) {
    Object.assign(notify, prefs);
  },
  async listSessions() {
    return sessions.map((session) => ({ ...session }));
  },
  async revokeSession(id) {
    const target = sessions.find((session) => session.id === id);
    // The server refuses the session the caller is using; the demo answers the same way rather than
    // signing the demo out of a screen that has no sign-in.
    if (target?.current) throw new Error('cannot revoke the current session');
    sessions = sessions.filter((session) => session.id !== id);
  },
  async changePassword(current, next) {
    if (next.length < MIN_PASSWORD_LENGTH) throw new Error('passwordTooShort');
    // Without a password to be wrong about, the form's error path would be unreachable in the demo and untestable.
    if (current !== MOCK_PASSWORD) throw new Error(WRONG_PASSWORD);
  },
  async capabilities() {
    // What this mock actually implements. Zipping a folder is the one thing it cannot do.
    // `copy` went true when the mock grew a real one; while it was false the menu greyed Copy and Copy to
    // even though Ctrl+C already worked, which is the kind of split the capability flags exist to prevent.
    return {
      upload: true,
      move: true,
      copy: true,
      delete: true,
      mkdir: true,
      search: true,
      versions: true,
      assistant: true,
      tags: true,
      activity: true,
      permissions: true,
      deleteForever: true,
      folderDownload: false,
    };
  },
  async search(query) {
    return search(query);
  },
  assistantAsk(prompt, mode, conversationId, signal) {
    return assistantAsk(prompt, mode, conversationId, signal);
  },

  async listRecent(filter) {
    const at = (n: Node) => Date.parse(n.openedAt ?? n.modifiedAt ?? '');
    return copy(nodes.filter((n) => n.kind === 'file' && live(n) && keep(n, filter))).sort((a, b) => at(b) - at(a));
  },
  async listStarred(filter) {
    return copy(nodes.filter((n) => n.starred && live(n) && keep(n, filter)));
  },
  async listShared(filter) {
    return copy(nodes.filter((n) => n.sharedBy && live(n) && keep(n, filter)));
  },
  async listTrash(filter) {
    // Only the top of a trashed subtree is listed; its children restore / vanish with it.
    return copy(nodes.filter((n) => n.deletedAt && (n.parentId === null || live(byId(n.parentId))) && keep(n, filter)));
  },
  async listFolders(storageId) {
    const storage = await this.getStorage(storageId);
    const inStorage = (n: Node): boolean => n.id === storage.rootId || (n.parentId !== null && inStorage(byId(n.parentId)));
    return copy(nodes.filter((n) => n.kind === 'folder' && live(n) && inStorage(n)));
  },

  async createFolder(parentId, name) {
    const parent = byId(parentId);
    assertNoSibling(parent.id, name);
    const now = new Date().toISOString();
    const node: Node = {
      id: newId(parent.id, name),
      name,
      kind: 'folder',
      parentId: parent.id,
      size: 0,
      modifiedAt: now,
      createdAt: now,
      ownerId: user.id,
      itemCount: 0,
      shared: false,
      starred: false,
    };
    nodes.push(node);
    bumpItemCount(parent.id, 1);
    return { ...node };
  },
  async uploadFile(parentId, file, options) {
    const parent = byId(parentId);
    await fakeTransfer(file.size, options?.onProgress);
    const now = new Date().toISOString();
    const fileType = fileTypeOf(file.name);
    const thumbnail = TYPE_THUMBNAILS[fileType];
    const node: Node = {
      id: newId(parent.id, file.name),
      name: file.name,
      kind: 'file',
      parentId: parent.id,
      size: file.size,
      modifiedAt: now,
      createdAt: now,
      ownerId: user.id,
      fileType,
      ...(thumbnail && { thumbnail }),
      shared: false,
      starred: false,
    };
    nodes.push(node);
    bumpItemCount(parent.id, 1);
    return { ...node };
  },
  async rename(id, name) {
    const node = byId(id);
    assertNoSibling(node.parentId, name, node.id);
    history.record(id, 'renamed', node.name);
    node.name = name;
    node.modifiedAt = new Date().toISOString();
    return { ...node };
  },
  async moveToTrash(ids) {
    const now = new Date().toISOString();
    for (const id of ids) {
      const node = byId(id);
      if (node.deletedAt) continue;
      node.deletedAt = now;
      node.originalPath = node.parentId ? absolutePath(node.parentId) : '/';
      history.record(id, 'trashed');
      bumpItemCount(node.parentId, -1);
    }
  },
  async restore(ids) {
    for (const id of ids) {
      const node = byId(id);
      if (!node.deletedAt) continue;
      delete node.deletedAt;
      delete node.originalPath;
      history.record(id, 'restored');
      bumpItemCount(node.parentId, 1);
    }
  },
  async deleteForever(ids) {
    const gone = new Set<string>();
    for (const id of ids) {
      const node = byId(id);
      if (!node.deletedAt) bumpItemCount(node.parentId, -1);
      for (const n of [node, ...descendants(node.id)]) gone.add(n.id);
    }
    nodes.splice(0, nodes.length, ...nodes.filter((n) => !gone.has(n.id)));
    for (const id of gone) history.forget(id);
  },
  async emptyTrash() {
    // Nested trashed nodes vanish with their ancestor; listing the top-level ones is enough.
    await this.deleteForever(nodes.filter((n) => n.deletedAt).map((n) => n.id));
  },
  async setStarred(ids, starred) {
    for (const id of ids) {
      byId(id).starred = starred;
      history.record(id, starred ? 'starred' : 'unstarred');
    }
  },
  async setTags(id, tags) {
    // Trimmed, de-duplicated, order preserved: what the user typed, minus the noise.
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    const node = byId(id);
    if (clean.length) node.tags = clean;
    else delete node.tags;
    history.record(id, 'tagged', clean.join(', '));
  },
  async move(ids, targetFolderId) {
    const target = byId(targetFolderId);
    if (target.kind !== 'folder') throw new Error(`not a folder: ${targetFolderId}`);
    for (const id of ids) {
      const node = byId(id);
      if (node.id === target.id || descendants(node.id).some((n) => n.id === target.id)) {
        throw new Error(`cannot move ${id} into itself`);
      }
      if (node.parentId === target.id) continue;
      bumpItemCount(node.parentId, -1);
      node.parentId = target.id;
      bumpItemCount(target.id, 1);
      history.record(id, 'moved', target.name);
    }
  },
  async copy(ids, targetFolderId) {
    const target = byId(targetFolderId);
    if (target.kind !== 'folder') throw new Error(`not a folder: ${targetFolderId}`);
    const now = new Date().toISOString();
    // Depth-first: a folder is cloned before its children, so each child already has a new parent to attach to.
    const clone = (node: Node, parentId: string) => {
      const name = copyName(parentId, node.name);
      const fresh: Node = { ...node, id: newId(parentId, name), name, parentId, createdAt: now, modifiedAt: now };
      delete fresh.shareUrl;
      fresh.shared = false;
      fresh.starred = false;
      nodes.push(fresh);
      bumpItemCount(parentId, 1);
      for (const child of nodes.filter((n) => n.parentId === node.id && live(n))) clone(child, fresh.id);
      // The clone's own log starts here; there is no 'copied' kind, and from the new node's side this IS its creation.
      history.record(fresh.id, 'created', node.name);
    };
    for (const id of ids) {
      const node = byId(id);
      if (node.id === target.id || descendants(node.id).some((n) => n.id === target.id)) {
        throw new Error(`cannot copy ${id} into itself`);
      }
      clone(node, target.id);
    }
  },
  async createShareLink(id) {
    const node = byId(id);
    node.shareUrl ??= `https://filex.example/s/${node.id.replace(/\//g, '-')}-${(++seq).toString(36)}`;
    node.shared = true;
    history.record(id, 'linkShared');
    return node.shareUrl;
  },
  async shareLink(id) {
    return byId(id).shareUrl ?? null;
  },
  async removeShareLink(id) {
    const node = byId(id);
    delete node.shareUrl;
    node.shared = false;
    history.record(id, 'linkRemoved');
  },
  async recordOpen(id) {
    // The search-only reference hits are not in `nodes`; opening them must not throw.
    const node = nodes.find((n) => n.id === id) ?? indexedOnly.find((n) => n.id === id);
    if (!node) throw new Error(`node not found: ${id}`);
    node.openedAt = new Date().toISOString();
  },
};
