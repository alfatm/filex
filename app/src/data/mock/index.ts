import { segments } from '@/lib/path';
import { DUPLICATE_NAME, type Repository } from '../repository';
import type { ListingFilter, Node } from '../types';
import { fileTypeOf, filterPeople, indexedOnly, live, nodes, storages, TYPE_THUMBNAILS, user } from './dataset';
import * as history from './history';
import { assistantAsk } from './assistant';
import { matchesFilter, search } from './search';

// `nodes` is the single in-memory state: search reads it too, so mutations edit that array in place.
const initial: Node[] = structuredClone(nodes);
let seq = 0;

/** Tests only: puts the dataset back to its initial shape. */
export function resetMock() {
  nodes.splice(0, nodes.length, ...structuredClone(initial));
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

function newId(parentId: string, name: string): string {
  const base = `${parentId}/${name}`.toLowerCase().replace(/[^a-z0-9/]+/g, '-');
  return nodes.some((n) => n.id === base) ? `${base}-${++seq}` : base;
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
    return history.listAccess(nodeId);
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
    return user;
  },
  async capabilities() {
    // What this mock actually implements. Zipping a folder is the one thing it cannot do.
    return {
      upload: true,
      move: true,
      copy: false,
      delete: true,
      mkdir: true,
      search: true,
      versions: true,
      ocr: true,
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
    const at = (n: Node) => Date.parse(n.openedAt ?? n.modifiedAt);
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
  async uploadFile(parentId, file) {
    const parent = byId(parentId);
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
  async createShareLink(id) {
    const node = byId(id);
    node.shareUrl ??= `https://filex.example/s/${node.id.replace(/\//g, '-')}-${(++seq).toString(36)}`;
    node.shared = true;
    history.record(id, 'linkShared');
    return node.shareUrl;
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
