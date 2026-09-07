import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Node } from '@/data/types';
import { anchorBelow } from '@/ui/FloatingMenu.vue';

export interface ItemMenuState {
  node: Node;
  x: number;
  y: number;
  /** Element that had focus before the menu opened; focus returns there on close. */
  returnTo: HTMLElement | null;
}

export const MENU_WIDTH = 232;

/** The single item ⋮ / context menu: cards, rows and right-click all open it here; `ItemMenuHost` renders it. */
export const useItemMenuStore = defineStore('itemMenu', () => {
  const state = ref<ItemMenuState | null>(null);

  function openAt(node: Node, x: number, y: number) {
    state.value = { node, x, y, returnTo: document.activeElement as HTMLElement | null };
  }

  /** Below the ⋮ button, right-aligned to it. */
  function openFor(node: Node, anchor: HTMLElement) {
    const { x, y } = anchorBelow(anchor, MENU_WIDTH);
    state.value = { node, x, y, returnTo: anchor };
  }

  function close() {
    const returnTo = state.value?.returnTo;
    state.value = null;
    returnTo?.focus();
  }

  return { state, openAt, openFor, close };
});
