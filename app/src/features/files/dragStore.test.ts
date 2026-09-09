import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Node } from '@/data/types';
import { useDragStore } from './dragStore';

const folder = (id: string): Node => ({ id, name: id, kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'me', shared: false, starred: false });

describe('dragStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

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

  it('lets an OS drag land on any live folder', () => {
    const drag = useDragStore();
    drag.files = true;
    expect(drag.canDrop(folder('demo://Docs'))).toBe(true);
    expect(drag.canDrop({ ...folder('demo://Old'), deletedAt: '2026-07-01T00:00:00Z' })).toBe(false);
  });
});
