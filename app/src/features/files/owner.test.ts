import { describe, expect, it } from 'vitest';
import { noQuota, type Node, type Storage } from '@/data/types';
import { sharedDriveOf } from './owner';

const drive = (name: string, rootId: string, shared: boolean, viaGroups: string[] = []): Storage => ({
  id: name,
  name,
  rootId,
  quota: noQuota(),
  shared,
  viaGroups,
});

const at = (id: string): Node =>
  ({ id, name: id, kind: 'file', parentId: null, size: 0, ownerId: '9', ownerName: 'Grace', shared: false, starred: false }) as Node;

describe('who a listing row belongs to', () => {
  it('names the drive on a shared one and nobody on a drive of your own', () => {
    const drives = [drive('main', 'main://', false), drive('Marketing', 'shared://', true)];
    expect(sharedDriveOf(at('shared://Q3/plan.md'), drives)).toBe('Marketing');
    // On your own drive the answer is a person, so this says nothing and lets the caller name them.
    expect(sharedDriveOf(at('main://Docs/a.md'), drives)).toBeNull();
  });

  it('claims the drive root itself, which is a row on the Shared with me page', () => {
    expect(sharedDriveOf(at('shared://'), [drive('Marketing', 'shared://', true)])).toBe('Marketing');
  });

  it('understands the mock’s bare root as well as the HTTP one', () => {
    // The two repositories spell a root differently: `main://` over HTTP, `demo` in the mock. A rule that knew only
    // one of them would silently put the column back to naming the caller in the other.
    expect(sharedDriveOf(at('demo/Design/a.png'), [drive('demo', 'demo', true)])).toBe('demo');
  });

  // filex has group grants now, and a team drive reached through one is the team's rather than the mount's.
  it('names the group a team drive is reached through, and the drive when no group leads to it', () => {
    const viaDesign = drive('Marketing', 'shared://', true, ['Design', 'Ops']);
    // The first group, not a list: the column is one line, and the answer to "whose is this" is the team.
    expect(sharedDriveOf(at('shared://Q3/plan.md'), [viaDesign])).toBe('Design');
    expect(sharedDriveOf(at('shared://'), [drive('Marketing', 'shared://', true)])).toBe('Marketing');
  });

  it('does not let one drive claim another whose name it is a prefix of', () => {
    const drives = [drive('main', 'main', true)];
    expect(sharedDriveOf(at('main2/Docs/a.md'), drives)).toBeNull();
    expect(sharedDriveOf(at('main/Docs/a.md'), drives)).toBe('main');
  });
});
