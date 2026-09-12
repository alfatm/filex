import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Node } from '@/data/types';
import { useCapabilitiesStore } from '@/stores/capabilities';

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

  const capabilities = useCapabilitiesStore();

  /** A node may not be dropped on itself, and an OS drag may land on any folder. */
  function canDrop(target: Node): boolean {
    if (target.kind !== 'folder' || target.deletedAt) return false;
    // The nodes decide whenever there are any: the two conditions used to be an `||`, so a stale `files` flag made
    // the folder BEING dragged a valid target for itself.
    // Dropping nodes IS a move, so a role without `files.move` never gets a drop target to aim at: no highlight,
    // no drop effect, nothing to explain afterwards.
    if (nodes.value.length) return capabilities.allows('files.move') && !nodes.value.some((n) => n.id === target.id);
    return files.value && capabilities.allows('files.upload');
  }

  return { nodes, overId, files, start, end, canDrop };
});
