import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Node } from '@/data/types';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';

/** Cut is a move in two steps, copy is a duplicate in two steps; the clipboard holds one or the other, never both. */
type Mode = 'cut' | 'copy';

export const useClipboardStore = defineStore('clipboard', () => {
  const files = useFilesStore();
  const capabilities = useCapabilitiesStore();
  const nodes = ref<Node[]>([]);
  const mode = ref<Mode>('cut');

  /**
   * The server verb each half of the clipboard will actually use, asked once here.
   *
   * Cut is a move and paste-after-copy is a server-side copy, so each needs its own flag — the menu's Paste entry
   * was gated on `move` even for a copy, while Ctrl+X and Ctrl+C were gated on nothing at all and filled a
   * clipboard whose paste the server was always going to refuse.
   */
  const canCut = computed(() => capabilities.can.move);
  const canCopy = computed(() => capabilities.can.copy);

  /** Pasting needs an open folder: the flat listings (Recent, Starred, Trash) are not places. */
  const canPaste = computed(
    () => nodes.value.length > 0 && files.listing?.kind === 'folder' && (mode.value === 'cut' ? canCut.value : canCopy.value),
  );

  function cut(list: Node[]) {
    if (!canCut.value) return;
    mode.value = 'cut';
    nodes.value = list.filter((n) => !n.deletedAt).map((n) => ({ ...n }));
  }

  function copy(list: Node[]) {
    if (!canCopy.value) return;
    mode.value = 'copy';
    nodes.value = list.filter((n) => !n.deletedAt).map((n) => ({ ...n }));
  }

  function clear() {
    nodes.value = [];
  }

  /** Only a cut greys its rows: a copy leaves the originals exactly where they are. */
  function isCut(id: string): boolean {
    return mode.value === 'cut' && nodes.value.some((n) => n.id === id);
  }

  async function paste() {
    const target = files.folder;
    if (!target) return;
    // A folder cannot land inside itself, in either mode.
    const blocked = new Set([target.id, ...files.path.map((n) => n.id)]);
    const pending = nodes.value.filter((n) => !blocked.has(n.id));
    // A cut into the folder the nodes already sit in has nowhere to go; the same paste as a copy duplicates them.
    const movable = mode.value === 'cut' ? pending.filter((n) => n.parentId !== target.id) : pending;
    const kind = mode.value;
    nodes.value = [];
    if (!movable.length) return;
    if (kind === 'cut') await files.move(movable, target);
    else await files.copyInto(movable, target);
  }

  return { nodes, mode, canCut, canCopy, canPaste, cut, copy, clear, isCut, paste };
});
