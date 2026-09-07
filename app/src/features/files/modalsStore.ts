import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Node } from '@/data/types';

export type DeleteVariant = 'trash' | 'forever' | 'emptyTrash';

/** One modal at a time (spec §7): the host component renders whichever is active. */
export type ActiveModal =
  | { kind: 'newFolder' }
  | { kind: 'rename'; node: Node }
  | { kind: 'share'; node: Node }
  /** The destination picker; the kind is also the verb it runs (spec §7). */
  | { kind: 'move' | 'copy'; nodes: Node[] }
  | { kind: 'tags'; node: Node }
  | { kind: 'versions'; node: Node }
  | { kind: 'access'; node: Node }
  | { kind: 'delete'; variant: DeleteVariant; nodes: Node[] }
  /** Full-screen file preview over `nodes` (files only, listing order), starting at `index`. */
  | { kind: 'preview'; nodes: Node[]; index: number };

export const useModalsStore = defineStore('modals', () => {
  const active = ref<ActiveModal | null>(null);

  function open(modal: ActiveModal) {
    active.value = modal;
  }
  function close() {
    active.value = null;
  }

  return { active, open, close };
});
