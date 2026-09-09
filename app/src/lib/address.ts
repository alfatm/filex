/**
 * A node's address, `<drive>://<path relative to its root>`, and the reading of it.
 *
 * The address IS the node's identity in this app — it is what the router carries, what survives a reload and what
 * every listing and mutation endpoint speaks. Which drive a node is on, what it is called and which folder holds it
 * are therefore questions about the address alone, answerable without asking anybody: domain knowledge, not a
 * detail of how the app happens to talk to the server today.
 */

/** `<adapter>://<rel>`; an empty `rel` is the storage root and stays as the bare `<adapter>://`. */
export function joinPath(adapter: string, rel: string): string {
  return `${adapter}://${rel.replace(/^\/+|\/+$/g, '')}`;
}

export function splitPath(id: string): { adapter: string; rel: string } {
  const at = id.indexOf('://');
  if (at < 0) return { adapter: '', rel: id.replace(/^\/+|\/+$/g, '') };
  return { adapter: id.slice(0, at), rel: id.slice(at + 3).replace(/^\/+|\/+$/g, '') };
}

/** The folder holding `id`, or null when `id` is a storage root (which has no parent). */
export function parentPath(id: string): string | null {
  const { adapter, rel } = splitPath(id);
  if (!rel) return null;
  return joinPath(adapter, rel.slice(0, rel.lastIndexOf('/') + 1));
}

export function nameOf(id: string): string {
  const { rel } = splitPath(id);
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/**
 * Whether `id` names something inside the folder `folderId`, at any depth. A folder's own address is a prefix of
 * every address under it, so nothing has to be listed to answer this — which is what lets a flat list of search
 * hits be judged against a folder nobody expanded.
 */
export function isInside(id: string, folderId: string): boolean {
  const prefix = folderId.endsWith('://') ? folderId : `${folderId}/`;
  return id !== folderId && id.startsWith(prefix);
}
