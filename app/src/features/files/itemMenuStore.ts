import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Node } from '@/data/types';
import { anchorBelow } from '@/ui/FloatingMenu.vue';

export interface ItemMenuState {
  /** null when the menu was opened on bare listing surface: the listing's own actions instead of a node's. */
  node: Node | null;
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

  /** Right-click on empty listing surface. */
  function openBackgroundAt(x: number, y: number) {
    state.value = { node: null, x, y, returnTo: document.activeElement as HTMLElement | null };
  }

  /** The grid's ⋮ button, which offers the same listing actions. */
  function openBackgroundFor(anchor: HTMLElement) {
    const { x, y } = anchorBelow(anchor, MENU_WIDTH);
    state.value = { node: null, x, y, returnTo: anchor };
  }

  function close() {
    const returnTo = state.value?.returnTo;
    state.value = null;
    returnTo?.focus();
  }

  return { state, openAt, openFor, openBackgroundAt, openBackgroundFor, close };
});
