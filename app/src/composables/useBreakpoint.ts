import { computed, ref } from 'vue';
import { MEDIA, TOUCH, type Layout } from '@/design/breakpoints';

/**
 * Which of the two reference layouts the window is showing.
 *
 * Shared module state rather than per-component listeners: the answer is the same for every caller, so one media
 * query serves the whole app and a component mounted mid-resize starts from the current value rather than from its
 * own first read. The listeners are never removed — they outlive nothing, since the module lives as long
 * as the page does.
 *
 * A window with no `matchMedia` (the unit-test DOM, unless a test stubs one) reports `desktop`: the layout the
 * spec is drawn for, so a test that says nothing about width gets the geometry the screenshots were taken at.
 */
function read(): Layout {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop';
  return window.matchMedia(MEDIA.mobile).matches ? 'mobile' : 'desktop';
}

const layout = ref<Layout>(read());

/** Fixed for the life of the page in every real case; a browser that switches input kinds still reports it. */
const touch = ref(typeof window !== 'undefined' && window.matchMedia?.(TOUCH).matches === true);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const update = () => (layout.value = read());
  // One query: there is one edge, and crossing it is the only way the layout can change.
  window.matchMedia(MEDIA.mobile).addEventListener('change', update);
  window.matchMedia(TOUCH).addEventListener('change', (event) => (touch.value = event.matches));
}

export function useBreakpoint() {
  return {
    layout: computed(() => layout.value),
    isMobile: computed(() => layout.value === 'mobile'),
    isDesktop: computed(() => layout.value === 'desktop'),
    isTouch: computed(() => touch.value),
  };
}
