import { afterEach, describe, expect, it, vi } from 'vitest';
import { swallowGhostClick } from './ghostClick';

afterEach(() => vi.useRealTimers());

/** What is underneath: the card a swipe leaves the finger over. */
function target() {
  document.body.innerHTML = '';
  const el = document.createElement('button');
  document.body.appendChild(el);
  const clicks = vi.fn();
  el.addEventListener('click', clicks);
  return { el, clicks };
}

describe('swallowGhostClick', () => {
  it('eats the click the gesture leaves behind, and only that one', () => {
    const { el, clicks } = target();
    swallowGhostClick();
    el.click();
    expect(clicks).not.toHaveBeenCalled();

    el.click();
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  // A deliberate tap that comes after the swipe must land: the press of a new gesture says the tail is over.
  it('lets go as soon as a new gesture starts', () => {
    const { el, clicks } = target();
    swallowGhostClick();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.click();
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  // A browser that sends no ghost click at all must not be left with a live trap.
  it('lets go on its own when no click follows', () => {
    vi.useFakeTimers();
    const { el, clicks } = target();
    swallowGhostClick();
    vi.advanceTimersByTime(1_000);
    el.click();
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
