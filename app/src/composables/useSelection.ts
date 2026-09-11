import { computed, ref, type Ref } from 'vue';

export interface SelectOptions {
  /** Ctrl/Cmd-click: toggle this id, keep the rest. */
  toggle?: boolean;
  /** Shift-click: flip this id and apply its new state to the whole anchor→id range. */
  range?: boolean;
}

export type SelectAllState = 'none' | 'some' | 'all';

/** Spec §4 keys beyond navigation: Enter opens, Delete removes, F2 renames. */
export interface KeyHandlers<T> {
  open: (item: T) => void;
  /** Delete. Receives one item; a multi-selection is expanded by the caller (see `useFileActions.run`). */
  remove?: (item: T) => void;
  /** F2. Only when exactly one item is addressed: the single selection, else the cursor with nothing selected. */
  rename?: (item: T) => void;
}

/**
 * Multi-selection over an ordered list. Shared by the grid and the list view
 * so the same ids stay selected when the view mode changes.
 */
export function useSelection<T extends { id: string }>(ordered: Readonly<Ref<T[]>>) {
  const selectedIds = ref<Set<string>>(new Set());
  // Anchor for shift-click ranges; kept as an id so re-sorting does not break it.
  const anchorId = ref<string | null>(null);
  /** Keyboard cursor; independent of the selection so Space can toggle it. */
  const focusedId = ref<string | null>(null);
  // The cursor ring is drawn only after keyboard navigation; a mouse click sets the cursor silently.
  const focusVisible = ref(false);
  const cursorId = computed(() => (focusVisible.value ? focusedId.value : null));

  const selected = computed(() => ordered.value.filter((n) => selectedIds.value.has(n.id)));
  const allState = computed<SelectAllState>(() => {
    const count = selected.value.length;
    if (count === 0) return 'none';
    return count === ordered.value.length ? 'all' : 'some';
  });

  function isSelected(id: string): boolean {
    return selectedIds.value.has(id);
  }

  function clear() {
    selectedIds.value = new Set();
    anchorId.value = null;
  }

  function select(id: string, opts: SelectOptions = {}) {
    const next = new Set(opts.toggle || opts.range ? selectedIds.value : []);
    const ids = ordered.value.map((n) => n.id);
    // A range needs an anchor that is still in the list; otherwise fall back to a plain click.
    const a = opts.range && anchorId.value ? ids.indexOf(anchorId.value) : -1;
    if (a !== -1) {
      // The shift-clicked item flips; the whole anchor→target range then follows its new state.
      const b = ids.indexOf(id);
      const on = !next.has(id);
      for (const i of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (on) next.add(i);
        else next.delete(i);
      }
      // A chain of shift-clicks starts each new range where the previous one ended.
      anchorId.value = id;
    } else {
      if (opts.toggle && next.has(id)) next.delete(id);
      else next.add(id);
      anchorId.value = id;
    }
    selectedIds.value = next;
    focusedId.value = id;
    focusVisible.value = false;
  }

  /** Maps the click modifiers to `SelectOptions` (Ctrl/Cmd → toggle, Shift → range). */
  function selectFromEvent(id: string, event: MouseEvent) {
    select(id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  }

  /** Checkbox semantics: flip one id, never touching the others. */
  function toggle(id: string) {
    select(id, { toggle: true });
  }

  function selectAll() {
    selectedIds.value = new Set(ordered.value.map((n) => n.id));
  }

  function moveFocus(delta: 1 | -1) {
    const ids = ordered.value.map((n) => n.id);
    if (!ids.length) return;
    const current = focusedId.value ? ids.indexOf(focusedId.value) : -1;
    const next = current === -1 ? (delta === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, current + delta));
    focusedId.value = ids[next];
    focusVisible.value = true;
  }

  function focused(): T | undefined {
    return ordered.value.find((n) => n.id === focusedId.value);
  }

  /** Spec §4 keys. Returns true when the event was consumed. */
  function handleKeydown(event: KeyboardEvent, on: KeyHandlers<T>): boolean {
    switch (event.key) {
      case 'ArrowDown':
        moveFocus(1);
        return true;
      case 'ArrowUp':
        moveFocus(-1);
        return true;
      case ' ': {
        const item = focused();
        if (!item) return false;
        toggle(item.id);
        focusVisible.value = true;
        return true;
      }
      case 'Enter': {
        const item = focused();
        if (!item) return false;
        on.open(item);
        return true;
      }
      case 'Delete': {
        // The first selected item stands for the whole selection; the cursor item when nothing is selected.
        const item = selected.value[0] ?? focused();
        if (!item || !on.remove) return false;
        on.remove(item);
        return true;
      }
      case 'F2': {
        const item = selected.value.length === 1 ? selected.value[0] : selected.value.length === 0 ? focused() : undefined;
        if (!item || !on.rename) return false;
        on.rename(item);
        return true;
      }
      case 'Escape':
        clear();
        focusVisible.value = false;
        return true;
      default:
        // `code` is layout-independent: Ctrl+A must work when the active layout produces 'ф' or 'a'.
        if (event.code !== 'KeyA' || !(event.ctrlKey || event.metaKey)) return false;
        selectAll();
        return true;
    }
  }

  return {
    selected,
    allState,
    focusedId,
    cursorId,
    isSelected,
    clear,
    select,
    selectFromEvent,
    toggle,
    selectAll,
    moveFocus,
    handleKeydown,
  };
}
