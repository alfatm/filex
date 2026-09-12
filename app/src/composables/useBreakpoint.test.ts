import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A `matchMedia` that answers from one number.
 *
 * happy-dom has one of its own, but it answers from `window.innerWidth` and does not deliver `change` — and the
 * whole point of the composable is that it follows a resize, so the stub has to be able to fire one.
 */
/** The change listeners take an event: the touch query reads `matches` off it, the layout ones re-read the width. */
type Listener = (event: { matches: boolean }) => void;

const lists: { query: string; listeners: Listener[]; matches: boolean }[] = [];
let width = 1672;

function matches(query: string): boolean {
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}

function resize(next: number) {
  width = next;
  for (const list of lists) {
    list.matches = matches(list.query);
    for (const listener of list.listeners) listener({ matches: list.matches });
  }
}

function install() {
  lists.length = 0;
  window.matchMedia = ((query: string) => {
    const list = { query, listeners: [] as Listener[], matches: matches(query) };
    lists.push(list);
    return {
      get matches() {
        return matches(query);
      },
      addEventListener: (_: string, listener: Listener) => list.listeners.push(listener),
    };
  }) as unknown as typeof window.matchMedia;
}

/** Fresh module per case: the layout is module state, so a second import would answer from the first width. */
async function load(at: number) {
  width = at;
  install();
  vi.resetModules();
  return (await import('./useBreakpoint')).useBreakpoint();
}

describe('useBreakpoint', () => {
  beforeEach(() => {
    width = 1672;
  });

  it.each([
    [390, 'mobile'],
    [767, 'mobile'],
    [768, 'desktop'],
    [834, 'desktop'],
    [1280, 'desktop'],
    [1672, 'desktop'],
  ])('reads %ipx as %s', async (at, expected) => {
    expect((await load(at)).layout.value).toBe(expected);
  });

  it('follows a resize across the edge', async () => {
    const { isMobile, isDesktop } = await load(1672);
    expect(isDesktop.value).toBe(true);

    resize(390);
    expect(isMobile.value).toBe(true);
    expect(isDesktop.value).toBe(false);

    resize(834);
    expect(isDesktop.value).toBe(true);
    expect(isMobile.value).toBe(false);
  });

  it('reports the design width when the DOM has no matchMedia', async () => {
    vi.resetModules();
    // @ts-expect-error — removing it is the case under test.
    delete window.matchMedia;
    expect((await import('./useBreakpoint')).useBreakpoint().layout.value).toBe('desktop');
  });
});
