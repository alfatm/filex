/**
 * Slash-separated paths relative to a storage root ("Design/Assets", "" for the root) and the
 * `files` route's `:path*` param (one segment per folder) are the two forms every path takes.
 */

/** Folder names of a slash-separated path or a route param; empty parts vanish, so "/a//b/" reads as ["a", "b"]. */
export function segments(path: string | string[] | undefined | null): string[] {
  if (Array.isArray(path)) return path.filter(Boolean);
  return (path ?? '').split('/').filter(Boolean);
}

/** "a/b" from ["a", "b"]; "" for the root. */
export function joinPath(parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

/** Router location of the folder at `parts` (relative to the storage root). */
export function filesRoute(parts: string[]) {
  return { name: 'files', params: { path: parts } } as const;
}
