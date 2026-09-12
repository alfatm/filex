import { computed, ref } from 'vue';
import { vi } from 'vitest';
import type { Layout } from '@/design/breakpoints';

/**
 * Pins the test DOM to a window width and hands back a fresh module graph.
 *
 * `useBreakpoint` keeps ONE piece of shared state for the whole app (that is the point of it), so a component that
 * has already been imported carries whichever layout was current when its module first ran. A test about a narrow
 * window therefore has to set the width first and `import()` the component after — which is what the reset here
 * is for. Without it the unit run answers "desktop" everywhere, because vitest.config.ts pins the DOM to the
 * design width and that is what a test which says nothing about width should get.
 *
 * ⚠ happy-dom has a `matchMedia` of its own and it answers from `innerWidth`, so this replaces it rather than
 * filling a gap: the stub also has to deliver `change`, which the built-in one does not.
 */
export function atWidth(width: number) {
  const matches = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches(query);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  vi.resetModules();
}

/** The two widths the reference sheet is drawn at (DESIGN-SPEC §10). */
export const PHONE = 390;
export const DESKTOP = 1672;

/**
 * The other way to write a test about width — and the one for any component that reaches for a store.
 *
 * `atWidth` resets the module registry, which gives the component under test its OWN copy of pinia and therefore
 * no active instance at all. Swapping the composable leaves the module graph alone:
 *
 *   vi.mock('@/composables/useBreakpoint', async () => (await import('@/test/viewport')).breakpointMock);
 *   setLayout('mobile');
 */
const mocked = ref<Layout>('desktop');
const mockedTouch = ref(false);

export function setLayout(layout: Layout, touch = layout !== 'desktop') {
  mocked.value = layout;
  mockedTouch.value = touch;
}

export const breakpointMock = {
  useBreakpoint: () => ({
    layout: computed(() => mocked.value),
    isMobile: computed(() => mocked.value === 'mobile'),
    isDesktop: computed(() => mocked.value === 'desktop'),
    isTouch: computed(() => mockedTouch.value),
  }),
};
