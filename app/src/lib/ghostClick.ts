/**
 * Swallows the click a finished touch gesture leaves behind.
 *
 * A swipe that dismisses something takes the element the finger is on out of the page, and the browser then hands
 * the compatibility mouse events of that same gesture to whatever is underneath: dismissing the preview with a
 * swipe ended in a click on the card the finger happened to stop over, which the listing read as "select this".
 * Those events cannot be cancelled in advance, so they are caught on the way down and dropped instead.
 *
 * The guard lets go at the first click it eats, at the first press of a NEW gesture, or after the longest a
 * gesture's tail can be — whichever comes first. Without that last part a browser that sends no ghost click at
 * all would leave a live trap behind it.
 */
const TAIL_MS = 350;

export function swallowGhostClick() {
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    done();
  };
  const done = () => {
    window.clearTimeout(timer);
    document.removeEventListener('click', stop, true);
    document.removeEventListener('pointerdown', done, true);
  };
  const timer = window.setTimeout(done, TAIL_MS);
  document.addEventListener('click', stop, true);
  document.addEventListener('pointerdown', done, true);
}
