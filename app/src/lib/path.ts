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

/**
 * Router location of the folder at `parts` on `drive`.
 *
 * The drive is the FIRST segment of the route param, so `/files/main/Docs/2026` is `main://Docs/2026` — the URL
 * says the same thing a node id does. It has to be in the address: without it a reload or a pasted link could
 * only guess which drive was meant, and would open the first one.
 */
export function filesRoute(drive: string, parts: string[]) {
  return { name: 'files', params: { path: [drive, ...parts] } };
}

/** The reverse: the drive named by a route param, and the folder path under it. */
export function splitRoute(param: string | string[] | undefined | null): { drive: string | null; path: string } {
  const [drive, ...rest] = segments(param);
  return { drive: drive ?? null, path: joinPath(rest) };
}
