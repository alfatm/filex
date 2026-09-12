/**
 * Whether a name can address an entry in a folder — the client's copy of the server's `validEntryName`.
 *
 * The same rule on both sides on purpose: the dialog refuses exactly what the request would be refused for, so it
 * never blocks a name the filesystem would have taken. Everything else a POSIX filesystem allows stays allowed —
 * `:` `*` `?` are ordinary characters in a name on the servers filex runs on, and refusing them here would also
 * make existing files unrenameable.
 *
 * Kept in step with `backend/internal/api/handlers/manager_mutate.go`.
 */
export function isValidEntryName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  return !name.includes('/') && !name.includes('\\');
}
