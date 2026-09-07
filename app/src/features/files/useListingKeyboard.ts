import { computed, watch } from 'vue';
import { useFilesStore } from '@/stores/files';
import { useFileActions } from './useFileActions';

/** Anything interactive inside the listing keeps its native keys (row checkbox, sort header, ⋮ menu). */
const INTERACTIVE = 'button, a, input, select, textarea, [contenteditable], [role="menu"], [role="dialog"]';

/**
 * The list/grid container is the single keyboard scope (tabindex 0 + aria-activedescendant); spec §4 keys go
 * through the files store's selection and the shared file actions. Shared by the folder view and the flat listings.
 */
export function useListingKeyboard() {
  const files = useFilesStore();
  const actions = useFileActions();

  function onKeydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    const consumed = files.handleKeydown(event, {
      open: actions.open,
      remove: (node) => void actions.run(node.deletedAt ? 'deleteForever' : 'moveToTrash', node),
      rename: (node) => {
        if (!node.deletedAt) void actions.run('rename', node);
      },
    });
    if (consumed) event.preventDefault();
  }

  const activeDescendant = computed(() => (files.focusedId ? `node-${files.focusedId}` : undefined));

  /** Clicking bare page surface clears the selection; items, buttons and menus own their clicks. */
  function onMainClick(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest('[data-id], button, [role="menu"]')) return;
    files.clearSelection();
  }

  // Keep the keyboard cursor visible while ↑/↓ walk past the viewport edge. Keyboard only (`cursorId`): a right-click
  // also moves the cursor, and scrolling then would close its menu.
  watch(
    () => files.cursorId,
    (id) => {
      if (id) document.getElementById(`node-${id}`)?.scrollIntoView({ block: 'nearest' });
    },
    { flush: 'post' },
  );

  return { onKeydown, onMainClick, activeDescendant, open: actions.open };
}
