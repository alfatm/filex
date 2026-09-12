import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Node } from '@/data/types';
import { useModalsStore } from './modalsStore';

const node = { id: 'design', name: 'Design', kind: 'folder' } as Node;

describe('modals store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('holds one modal at a time; opening another replaces it, close clears it', () => {
    const modals = useModalsStore();
    expect(modals.active).toBeNull();
    modals.open({ kind: 'newFolder' });
    expect(modals.active).toEqual({ kind: 'newFolder' });
    modals.open({ kind: 'rename', node });
    expect(modals.active).toEqual({ kind: 'rename', node });
    modals.open({ kind: 'delete', variant: 'emptyTrash', nodes: [] });
    expect(modals.active?.kind).toBe('delete');
    modals.close();
    expect(modals.active).toBeNull();
  });
});
