import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Node } from '@/data/types';

/**
 * The one drag in flight. Two kinds cross the listing: nodes dragged inside the app (dropping them on a folder
 * moves them) and files dragged from the OS (dropping them uploads). Both highlight the same targets.
 */
export const useDragStore = defineStore('drag', () => {
  /** Nodes being dragged; empty during an OS file drag. */
  const nodes = ref<Node[]>([]);
  /** Id of the folder currently under the pointer, or 'listing' for the page's own drop area. */
  const overId = ref<string | null>(null);
  /** An OS drag is hovering the window. */
  const files = ref(false);

  function start(list: Node[]) {
    nodes.value = list;
  }

  function end() {
    nodes.value = [];
    overId.value = null;
    files.value = false;
  }

  /** A node may not be dropped on itself, and an OS drag may land on any folder. */
  function canDrop(target: Node): boolean {
    if (target.kind !== 'folder' || target.deletedAt) return false;
    return files.value || (nodes.value.length > 0 && !nodes.value.some((n) => n.id === target.id));
  }

  return { nodes, overId, files, start, end, canDrop };
});
