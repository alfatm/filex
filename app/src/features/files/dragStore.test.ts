import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type Node } from '@/data/types';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useDragStore } from './dragStore';

const folder = (id: string): Node => ({ id, name: id, kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'me', shared: false, starred: false });

describe('dragStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // Dropping is moving (or uploading), so the role has to carry it before a target can light up at all.
    useCapabilitiesStore().can.allowed = new Set(ROLE_PERMISSIONS);
  });

  // The two conditions used to be an `||`, and the OS flag stayed on after a drag that left the window: every
  // folder then lit up as a valid target for the next in-app drag, including the folder being dragged.
  it('never offers the folder being dragged as its own target, whatever the file flag says', () => {
    const drag = useDragStore();
    const design = folder('demo://Design');
    drag.start([design]);
    drag.files = true;

    expect(drag.canDrop(design)).toBe(false);
    expect(drag.canDrop(folder('demo://Docs'))).toBe(true);
  });

  // A drop IS a move, so a role that may not move must not be given a target to aim at: no highlight, no drop
  // effect, and nothing to explain after the fact.
  it('offers no target at all to a role that may not move, and none to one that may not upload', () => {
    const capabilities = useCapabilitiesStore();
    const drag = useDragStore();
    drag.start([folder('demo://Design')]);
    capabilities.can.allowed = new Set(ROLE_PERMISSIONS.filter((id) => id !== 'files.move'));
    expect(drag.canDrop(folder('demo://Docs'))).toBe(false);

    drag.end();
    drag.files = true;
    capabilities.can.allowed = new Set(ROLE_PERMISSIONS.filter((id) => id !== 'files.upload'));
    expect(drag.canDrop(folder('demo://Docs'))).toBe(false);
  });

  it('lets an OS drag land on any live folder', () => {
    const drag = useDragStore();
    drag.files = true;
    expect(drag.canDrop(folder('demo://Docs'))).toBe(true);
    expect(drag.canDrop({ ...folder('demo://Old'), deletedAt: '2026-07-01T00:00:00Z' })).toBe(false);
  });
});
