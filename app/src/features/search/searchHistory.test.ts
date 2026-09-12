import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyQuery } from './searchStore';
import { HISTORY_LIMIT, emptyHistory, readHistory, remember, writeHistory } from './searchHistory';

const search = (text: string, path = '') => ({ ...emptyQuery(), text, path });

// happy-dom exposes no localStorage here; the module only needs getItem/setItem (same stub as the view store's).
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
});

describe('searchHistory', () => {
  beforeEach(() => backing.clear());

  it('keeps the newest first and never the same search twice', () => {
    let history = emptyHistory();
    history = remember(history, search('rapor'));
    history = remember(history, search('plan'));
    expect(history.queries).toEqual(['plan', 'rapor']);

    // Searching for it again moves it up rather than adding a second copy: a list whose top three entries are one
    // string has stopped suggesting anything.
    history = remember(history, search('rapor'));
    expect(history.queries).toEqual(['rapor', 'plan']);
  });

  it('treats a difference of case or space as the same search, and keeps the latest spelling', () => {
    let history = remember(emptyHistory(), search('Rapor'));
    history = remember(history, search('  rapor  '));
    expect(history.queries).toEqual(['rapor']);
  });

  it('records the Path box separately, and records nothing for an empty box', () => {
    let history = remember(emptyHistory(), search('rapor', '/demo/design/'));
    expect(history).toEqual({ queries: ['rapor'], paths: ['/demo/design/'] });

    // A search with no path must not push an empty string into the suggestions.
    history = remember(history, search('plan'));
    expect(history.paths).toEqual(['/demo/design/']);
  });

  it('hands back the same object when nothing changed, so a re-run search does not touch storage', () => {
    const history = remember(emptyHistory(), search('rapor', '/demo/'));
    // The results page re-searches after a rename; that is the same search, not a new one.
    expect(remember(history, search('rapor', '/demo/'))).toBe(history);
  });

  it('stops at the limit, dropping the oldest', () => {
    let history = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) history = remember(history, search(`q${i}`));
    expect(history.queries).toHaveLength(HISTORY_LIMIT);
    expect(history.queries[0]).toBe(`q${HISTORY_LIMIT + 4}`);
    expect(history.queries).not.toContain('q0');
  });

  it('round-trips through storage', () => {
    writeHistory({ queries: ['rapor'], paths: ['/demo/'] });
    expect(readHistory()).toEqual({ queries: ['rapor'], paths: ['/demo/'] });
  });

  it('reads an absent, unparseable or wrong-shaped entry as no history at all', () => {
    expect(readHistory()).toEqual(emptyHistory());

    localStorage.setItem('filex.searchHistory', 'not json');
    expect(readHistory()).toEqual(emptyHistory());

    // Something another version — or another tab's bug — could have left behind.
    localStorage.setItem('filex.searchHistory', JSON.stringify({ queries: 'rapor', paths: [1, 'ok', ''] }));
    expect(readHistory()).toEqual({ queries: [], paths: ['ok'] });
  });

  it('survives a browser that refuses storage', () => {
    const denied = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
    // A private window is not a broken search box: both sides swallow it and the suggestions are simply absent.
    expect(readHistory()).toEqual(emptyHistory());
    expect(() => writeHistory({ queries: ['rapor'], paths: [] })).not.toThrow();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => backing.set(key, value),
    });
  });
});
