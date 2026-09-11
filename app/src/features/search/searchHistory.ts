import type { SearchQuery } from '@/data/types';

/**
 * What has been searched for on this browser, for the boxes to complete against.
 *
 * The alternative was completing the Path box against the folders that EXIST — a request per keystroke, answering
 * with a drive's whole tree, most of which the person asking has never opened. What they actually retype is what
 * they typed before, so that is what is offered. It also costs no request and needs no server at all.
 *
 * Per browser, deliberately: this is a convenience, not a document. It never leaves the device, it is never read
 * back by anything but the two boxes below, and a browser that hands back nothing — a private window, cleared site
 * data, storage switched off — leaves the boxes working exactly as they did before there was a history.
 */
export interface SearchHistory {
  /** Query texts, most recent first. */
  queries: string[];
  /** Paths typed into the Path box, most recent first, in the form they were typed. */
  paths: string[];
}

const KEY = 'filex.searchHistory';

/**
 * How many of each are kept. Twenty is about a week of one person's searching, and it is also the point past
 * which a completion list stops being a shortlist and becomes something to read — the suggestions are there to
 * save typing, not to be browsed.
 */
export const HISTORY_LIMIT = 20;

export function emptyHistory(): SearchHistory {
  return { queries: [], paths: [] };
}

/** Reads the history; anything unreadable, absent or the wrong shape reads as an empty one. */
export function readHistory(): SearchHistory {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyHistory();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyHistory();
    const { queries, paths } = parsed as Partial<SearchHistory>;
    return { queries: clean(queries), paths: clean(paths) };
  } catch {
    // A browser that refuses storage, or an entry another version wrote. Neither is a reason to break a search.
    return emptyHistory();
  }
}

export function writeHistory(history: SearchHistory) {
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    // Out of quota, or storage switched off. The suggestions are a convenience; losing them is not a failure.
  }
}

/**
 * The history with this search recorded — most recent first, no duplicates, capped.
 *
 * Repeating a search MOVES it to the front rather than adding a second copy: a list of suggestions whose top
 * entries are the same string three times is a list that has stopped suggesting anything.
 *
 * Case and surrounding space are the user's: `Rapor` and `rapor` are two ways of typing the same search, and
 * offering both back is offering a choice nobody has to make. The one kept is the one typed most recently, so a
 * suggestion always looks like something this person writes.
 */
export function remember(history: SearchHistory, query: SearchQuery): SearchHistory {
  const queries = prepend(history.queries, query.text);
  const paths = prepend(history.paths, query.path);
  // The SAME object when neither list moved, so a caller can tell "already recorded" from "recorded" and leave
  // storage — and anything watching the history — alone. The results page re-searches after a rename, and that is
  // the same search, not a new one.
  if (queries === history.queries && paths === history.paths) return history;
  return { queries, paths };
}

function prepend(list: string[], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return list;
  const rest = list.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
  // Already at the front and spelled the same way: nothing changed, so hand back the SAME array. It is what lets
  // a re-run search — the page re-searches after a rename — leave the suggestion lists untouched.
  if (rest.length === list.length - 1 && list[0] === trimmed) return list;
  return [trimmed, ...rest].slice(0, HISTORY_LIMIT);
}

function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = list.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return [...new Set(out)].slice(0, HISTORY_LIMIT);
}
