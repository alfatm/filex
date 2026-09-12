import type { Node, Storage } from '@/data/types';

/**
 * The drive a row lives on, when that drive is a shared one — and null otherwise.
 *
 * It is the Owner column's first question. On a drive of your own, naming a person is useful: it is either you or
 * whoever put the file there. On a team drive it is noise — everybody in it can see everybody's files, and what the
 * reader needs to know is that the drive is not theirs — so the column names the DRIVE there, the way Drive names a
 * shared drive. Which drives are shared is the server's answer (`Storage.shared`), not a guess from the address.
 *
 * Matching is by the drive's root address rather than by splitting the id, because the two repositories spell a root
 * differently — `main://` over HTTP, `demo` in the mock — and a rule that understood only one of them would put the
 * whole column back to naming the caller in the other.
 */
export function sharedDriveOf(node: Node, storages: Storage[]): string | null {
  for (const storage of storages) {
    if (!storage.shared) continue;
    if (node.id === storage.rootId) return labelOf(storage);
    // The boundary matters: without it a drive called `main` would claim rows on a drive called `main2`.
    if (node.id.startsWith(storage.rootId) && (storage.rootId.endsWith('/') || node.id[storage.rootId.length] === '/')) {
      return labelOf(storage);
    }
  }
  return null;
}

/**
 * What the column calls the drive.
 *
 * The GROUP where there is one: a drive reached through "Design" is the design team's, and naming the team says
 * who the files belong to in a way the mount's name cannot. Several groups can lead to one drive; the first is
 * named rather than a list, because the column is one line and the answer to "whose is this" is the team. A drive
 * reached some other way keeps its own name.
 */
function labelOf(storage: Storage): string {
  return storage.viaGroups[0] ?? storage.name;
}
