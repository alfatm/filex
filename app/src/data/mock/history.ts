import type { ActivityEvent, Node, Person, Version } from '../types';
import { live, nodes, user } from './dataset';

/**
 * Per-node history and access, kept beside the node table: revisions, the activity log and who can see what. The
 * seeds are derived from the node's own dates so a fresh mock already reads like a system that has been in use;
 * every mutation appends to the log from `mockRepository`.
 */

const HOUR = 60 * 60 * 1000;
/** How many revisions a seeded file pretends to have, and how far apart they sit. */
const SEEDED_VERSIONS = 3;
const VERSION_GAP_HOURS = 26;
/** Each older revision is this much smaller than the one after it. */
const VERSION_SHRINK = 0.82;

const versions = new Map<string, Version[]>();
const activity = new Map<string, ActivityEvent[]>();
const access = new Map<string, Person[]>();
let seq = 0;

export function resetHistory() {
  versions.clear();
  activity.clear();
  access.clear();
  seq = 0;
}

function byId(id: string): Node | undefined {
  return nodes.find((n) => n.id === id);
}

function id(prefix: string): string {
  return `${prefix}-${++seq}`;
}

/** Revisions of a file, newest first. Folders have none, so the modal says so instead of inventing history. */
export function listVersions(nodeId: string): Version[] {
  const node = byId(nodeId);
  if (!node || node.kind !== 'file') return [];
  const known = versions.get(nodeId);
  if (known) return known;
  const at = Date.parse(node.modifiedAt ?? '');
  const seeded = Array.from({ length: SEEDED_VERSIONS }, (_, i) => ({
    id: `${nodeId}@${i}`,
    at: new Date(at - i * VERSION_GAP_HOURS * HOUR).toISOString(),
    size: Math.round(node.size * VERSION_SHRINK ** i),
    authorId: node.ownerId,
    authorName: node.ownerName ?? user.name,
    current: i === 0,
  }));
  versions.set(nodeId, seeded);
  return seeded;
}

/** The restored revision's content becomes a new current revision; the history in between is kept. */
export function restoreVersion(nodeId: string, versionId: string): Version {
  const list = listVersions(nodeId);
  const source = list.find((v) => v.id === versionId);
  if (!source) throw new Error(`version not found: ${versionId}`);
  const now = new Date().toISOString();
  const restored: Version = { ...source, id: id('version'), at: now, current: true, authorId: user.id, authorName: user.name };
  versions.set(nodeId, [restored, ...list.map((v) => ({ ...v, current: false }))]);
  const node = byId(nodeId);
  if (node) {
    node.size = source.size;
    node.modifiedAt = now;
  }
  return restored;
}

export function listActivity(nodeId: string): ActivityEvent[] {
  const node = byId(nodeId);
  if (!node) return [];
  const logged = activity.get(nodeId) ?? [];
  // The two events every node carries in its own fields, so the tab is never empty.
  const seeded: ActivityEvent[] = [
    ...(node.modifiedAt ? [{ id: `${nodeId}:modified`, at: node.modifiedAt, actorId: node.ownerId, actorName: node.ownerName ?? user.name, kind: 'modified' as const }] : []),
    ...(node.createdAt ? [{ id: `${nodeId}:created`, at: node.createdAt, actorId: node.ownerId, actorName: node.ownerName ?? user.name, kind: 'created' as const }] : []),
  ];
  return [...logged, ...seeded].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Called by every mutation that changes a node, so the tab reflects what the user just did. */
export function record(nodeId: string, kind: ActivityEvent['kind'], detail?: string) {
  const entry: ActivityEvent = { id: id('event'), at: new Date().toISOString(), actorId: user.id, actorName: user.name, kind, detail };
  activity.set(nodeId, [entry, ...(activity.get(nodeId) ?? [])]);
}

/** Everyone with access to a node. A node nobody was invited to is the owner's alone. */
export function listAccess(nodeId: string): Person[] {
  const known = access.get(nodeId);
  if (known) return known;
  const node = byId(nodeId);
  // The current user keeps the initial the rest of the shell shows for them; other owners get theirs from the name.
  const owner: Person =
    node && node.ownerId !== user.id
      ? { id: node.ownerId, name: node.ownerName ?? node.ownerId, initial: (node.ownerName ?? node.ownerId).charAt(0).toUpperCase(), role: 'owner' }
      : { id: user.id, name: user.name, initial: user.initial, role: 'owner' };
  const seeded = [owner];
  access.set(nodeId, seeded);
  return seeded;
}

/** The address is the identity; the display name is what a server would resolve it to. */
export function addPerson(nodeId: string, email: string, role: Person['role']) {
  const list = [...listAccess(nodeId)];
  const address = email.trim().toLowerCase();
  if (!address || list.some((p) => p.id === address)) return;
  const name = address.split('@')[0].replace(/[._-]+/g, ' ');
  list.push({ id: address, name, initial: name.charAt(0).toUpperCase(), role });
  access.set(nodeId, list);
  record(nodeId, 'invited', name);
}

export function setPersonRole(nodeId: string, personId: string, role: Person['role']) {
  // The owner's own role is not a permission anyone can hand out.
  access.set(
    nodeId,
    listAccess(nodeId).map((p) => (p.id === personId && p.role !== 'owner' ? { ...p, role } : p)),
  );
}

export function removePerson(nodeId: string, personId: string) {
  const person = listAccess(nodeId).find((p) => p.id === personId);
  if (!person || person.role === 'owner') return;
  access.set(
    nodeId,
    listAccess(nodeId).filter((p) => p.id !== personId),
  );
  record(nodeId, 'revoked', person.name);
}

/** A node that left the tree takes its history with it. */
export function forget(nodeId: string) {
  if (byId(nodeId) && live(byId(nodeId)!)) return;
  versions.delete(nodeId);
  activity.delete(nodeId);
  access.delete(nodeId);
}
