import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Node } from '@/data/types';
import { useFilesStore } from '@/stores/files';

/**
 * Cut and paste, which for a file manager is a move in two steps. Copying is a separate feature (it needs a server
 * side copy), so the clipboard holds one kind of entry only.
 */
export const useClipboardStore = defineStore('clipboard', () => {
  const files = useFilesStore();
  const nodes = ref<Node[]>([]);

  /** Pasting needs an open folder: the flat listings (Recent, Starred, Trash) are not places. */
  const canPaste = computed(() => nodes.value.length > 0 && files.listing?.kind === 'folder');

  function cut(list: Node[]) {
    nodes.value = list.filter((n) => !n.deletedAt).map((n) => ({ ...n }));
  }

  function clear() {
    nodes.value = [];
  }

  function isCut(id: string): boolean {
    return nodes.value.some((n) => n.id === id);
  }

  async function paste() {
    const target = files.folder;
    if (!target) return;
    // A folder cannot land inside itself, and a node already here has nowhere to go.
    const blocked = new Set([target.id, ...files.path.map((n) => n.id)]);
    const movable = nodes.value.filter((n) => !blocked.has(n.id) && n.parentId !== target.id);
    nodes.value = [];
    if (movable.length) await files.move(movable, target);
  }

  return { nodes, canPaste, cut, clear, isCut, paste };
});
