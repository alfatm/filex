import { computed, watch } from 'vue';
import { useFilesStore } from '@/stores/files';
import { useClipboardStore } from './clipboardStore';
import { useItemMenuStore } from './itemMenuStore';
import { useUndoStore } from './undoStore';
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
  const itemMenu = useItemMenuStore();
  const clipboard = useClipboardStore();
  const history = useUndoStore();

  function onKeydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    // `code`, not `key`: the shortcuts must survive a non-latin keyboard layout, as Ctrl+A already does.
    if (event.ctrlKey || event.metaKey) {
      // What the shortcuts act on: the selection, else the row under the keyboard cursor.
      const subject = () => (files.selected.length ? files.selected : files.ordered.filter((n) => n.id === files.focusedId));
      if (event.code === 'KeyX') {
        const cut = subject();
        if (cut.length) clipboard.cut(cut);
        return event.preventDefault();
      }
      if (event.code === 'KeyC') {
        const copied = subject();
        if (copied.length) clipboard.copy(copied);
        return event.preventDefault();
      }
      if (event.code === 'KeyV') {
        if (clipboard.canPaste) void clipboard.paste();
        return event.preventDefault();
      }
      if (event.code === 'KeyZ') {
        void (event.shiftKey ? history.redo() : history.undo());
        return event.preventDefault();
      }
      // Anything else with a modifier falls through: Ctrl+A is select-all, and it lives in `handleKeydown`.
    }
    // Refresh. Ctrl+R belongs to the browser and F5 is the browser's too, so the listing takes the bare letter —
    // free here, since the listing has no type-ahead. Every modifier is excluded so Ctrl+R still reloads the page.
    if (event.code === 'KeyR' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      void files.refresh();
      return event.preventDefault();
    }
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

  /** Right-click on the same bare surface opens the listing's own menu; cards and rows open their node's. */
  function onMainContextMenu(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest('[data-id], button, [role="menu"], [role="dialog"]')) return;
    event.preventDefault();
    itemMenu.openBackgroundAt(event.clientX, event.clientY);
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

  return { onKeydown, onMainClick, onMainContextMenu, activeDescendant, open: actions.open };
}
