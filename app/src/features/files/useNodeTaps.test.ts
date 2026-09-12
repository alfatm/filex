import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import type { Node } from '@/data/types';
import { useNodeTaps } from './useNodeTaps';

const folder: Node = { id: 'demo://Docs', name: 'Docs', kind: 'folder', parentId: 'demo://', size: 0, ownerId: 'u1', shared: false, starred: false };
const file: Node = { id: 'demo://Docs/a.md', name: 'a.md', kind: 'file', parentId: 'demo://Docs', size: 3, ownerId: 'u1', shared: false, starred: false };

/** A card, as far as the gesture is concerned: one element the handlers are bound to. */
function card(handlers: Parameters<typeof useNodeTaps>[0], node: Node) {
  const Card = defineComponent({
    setup() {
      const taps = useNodeTaps(handlers);
      return () =>
        h('div', {
          onPointerdown: (event: PointerEvent) => taps.down(event, node),
          onPointermove: taps.move,
          onPointerup: (event: PointerEvent) => taps.up(event, node),
          onPointercancel: taps.cancel,
        });
    },
  });
  return mount(Card);
}

const touch = (extra: Record<string, unknown> = {}) => ({ pointerType: 'touch', clientX: 0, clientY: 0, ...extra });

describe('useNodeTaps', () => {
  it('opens a folder on a single tap, with no wait for a second one', async () => {
    const tap = vi.fn();
    const wrapper = card({ tap, doubleTap: vi.fn() }, folder);
    await wrapper.trigger('pointerdown', touch());
    await wrapper.trigger('pointerup', touch());
    expect(tap).toHaveBeenCalledWith(folder);
  });

  // A file has two gestures, so its tap has to wait long enough to tell them apart.
  it('holds a tap on a file until a second one could have arrived', async () => {
    vi.useFakeTimers();
    const tap = vi.fn();
    const doubleTap = vi.fn();
    const wrapper = card({ tap, doubleTap }, file);
    await wrapper.trigger('pointerdown', touch());
    await wrapper.trigger('pointerup', touch());
    expect(tap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(tap).toHaveBeenCalledWith(file);
    expect(doubleTap).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reads two taps in a row as the double tap', async () => {
    vi.useFakeTimers();
    const tap = vi.fn();
    const doubleTap = vi.fn();
    const wrapper = card({ tap, doubleTap }, file);
    for (const _ of [0, 1]) {
      await wrapper.trigger('pointerdown', touch());
      await wrapper.trigger('pointerup', touch());
    }
    vi.advanceTimersByTime(500);
    expect(doubleTap).toHaveBeenCalledWith(file);
    expect(tap).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('brings the menu up on a long press, and no tap after it', async () => {
    vi.useFakeTimers();
    const tap = vi.fn();
    const longPress = vi.fn();
    const wrapper = card({ tap, longPress }, file);
    await wrapper.trigger('pointerdown', touch());
    vi.advanceTimersByTime(600);
    await wrapper.trigger('pointerup', touch());
    expect(longPress).toHaveBeenCalled();
    expect(tap).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // A finger that travels is scrolling the listing, and a listing that opens a folder when you scroll is unusable.
  it('lets a scroll cancel the press', async () => {
    vi.useFakeTimers();
    const longPress = vi.fn();
    const wrapper = card({ tap: vi.fn(), longPress }, file);
    await wrapper.trigger('pointerdown', touch());
    await wrapper.trigger('pointermove', touch({ clientY: 40 }));
    vi.advanceTimersByTime(600);
    expect(longPress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // The mouse keeps every behaviour it had: click selects, double-click opens, right-click brings the menu.
  it('ignores a mouse entirely', async () => {
    const tap = vi.fn();
    const wrapper = card({ tap }, folder);
    await wrapper.trigger('pointerdown', { pointerType: 'mouse', clientX: 0, clientY: 0 });
    await wrapper.trigger('pointerup', { pointerType: 'mouse', clientX: 0, clientY: 0 });
    expect(tap).not.toHaveBeenCalled();
  });

  /*
   * The gesture that dismisses an overlay ends over the listing.
   *
   * The preview and the details sheet close in the middle of a swipe, and the browser gives what is left of that
   * gesture to whatever is under the finger — so the card it stopped over got a release with no press of its own,
   * and opened.
   */
  it('ignores a release whose press it never saw', async () => {
    const tap = vi.fn();
    const wrapper = card({ tap }, folder);
    await wrapper.trigger('pointerup', touch({ pointerId: 3 }));
    expect(tap).not.toHaveBeenCalled();
  });

  // `pointercancel` is the browser saying it has taken the gesture for a scroll. What it took is not a tap.
  it('ignores the release after the browser has taken the gesture', async () => {
    const tap = vi.fn();
    const wrapper = card({ tap }, folder);
    await wrapper.trigger('pointerdown', touch({ pointerId: 3 }));
    await wrapper.trigger('pointercancel', touch({ pointerId: 3 }));
    await wrapper.trigger('pointerup', touch({ pointerId: 3 }));
    expect(tap).not.toHaveBeenCalled();
  });
});
