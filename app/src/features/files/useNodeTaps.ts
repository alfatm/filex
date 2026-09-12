import { onBeforeUnmount } from 'vue';
import type { Node } from '@/data/types';

/**
 * What a finger can do to a row or a card, since a mouse's vocabulary does not survive the trip.
 *
 * The listing was built for a pointer: a click selects, a double-click opens, the right button brings the menu.
 * On a touch screen the first of those is the only one that happens — measured on a phone, tapping a folder did
 * nothing at all, because "open" was waiting for a second click that a tap never produces.
 *
 * So, under a coarse pointer only (a mouse keeps every behaviour it had):
 *   tap          opens — the folder, or the file's preview
 *   double tap   the details of a file, at full height
 *   long press   the item menu, standing in for the right button
 *
 * A tap on a FILE is held for `DOUBLE_TAP_MS` before it acts, because that is the only way to tell it from the
 * first half of a double tap. Folders do not wait: nothing is listening for a second tap on them.
 */
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_MS = 260;
/** A finger that travels this far was scrolling, not pressing. */
const SLOP_PX = 10;

interface TapHandlers {
  tap: (node: Node) => void;
  doubleTap?: (node: Node) => void;
  longPress?: (node: Node, target: HTMLElement, event: PointerEvent) => void;
}

export function useNodeTaps(handlers: TapHandlers) {
  let press: number | undefined;
  let pending: number | undefined;
  let pendingId: string | null = null;
  let startX = 0;
  let startY = 0;
  /** Set once the long press has fired, so the release that follows is not also a tap. */
  let handled = false;
  /** The press this release has to belong to; see `up`. */
  let downId: number | null = null;

  function clearPress() {
    if (press !== undefined) window.clearTimeout(press);
    press = undefined;
  }

  function clearPending() {
    if (pending !== undefined) window.clearTimeout(pending);
    pending = undefined;
    pendingId = null;
  }

  onBeforeUnmount(() => {
    clearPress();
    clearPending();
  });

  function down(event: PointerEvent, node: Node) {
    if (event.pointerType !== 'touch') return;
    handled = false;
    downId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    if (!handlers.longPress) return;
    press = window.setTimeout(() => {
      handled = true;
      clearPending();
      handlers.longPress?.(node, event.currentTarget as HTMLElement, event);
    }, LONG_PRESS_MS);
  }

  function move(event: PointerEvent) {
    if (press === undefined) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > SLOP_PX) clearPress();
  }

  function up(event: PointerEvent, node: Node) {
    if (event.pointerType !== 'touch') return;
    /*
     * A release whose press landed somewhere else, or one the browser already took back.
     *
     * The overlays a finger swipes away — the preview, the details sheet — close in the MIDDLE of the gesture,
     * and the browser then gives the rest of it to whatever is under the finger by then: the listing. Measured, a
     * swipe that dismissed the preview opened the card the finger stopped over. The same comparison drops the
     * release after a `pointercancel`, which is the browser saying it has taken the gesture for a scroll.
     */
    if (downId !== event.pointerId) return;
    downId = null;
    clearPress();
    if (handled) return;
    // The browser would follow this with its own click, which the listing reads as "select". The gesture has
    // already said what it meant.
    event.preventDefault();

    if (pending !== undefined && pendingId === node.id) {
      clearPending();
      handlers.doubleTap?.(node);
      return;
    }
    clearPending();
    if (!handlers.doubleTap || node.kind === 'folder') return handlers.tap(node);
    pendingId = node.id;
    pending = window.setTimeout(() => {
      clearPending();
      handlers.tap(node);
    }, DOUBLE_TAP_MS);
  }

  function cancel() {
    downId = null;
    clearPress();
  }

  return { down, move, up, cancel };
}
