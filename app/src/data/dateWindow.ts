import type { LocationQuery } from 'vue-router';
import { AROUND_SPANS, type DateWindow } from './types';

/**
 * A window of a fixed width around one moment — "what else was written around then" — and how it is spelled in a
 * URL.
 *
 * It lives on its own because two features now ask the same question: the listing chips (set from the details
 * panel) and the advanced search. One shape, one spelling, one validator; two copies would be two answers to
 * "what does `span=week` mean" the day one of them grew a fourth width.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Half-widths, either side of the moment the window names. A property click starts at a day. */
export const AROUND_SPAN_MS = { hour: HOUR, day: DAY, week: 7 * DAY } as const;

/** The window's edges, in epoch milliseconds. */
export function windowBounds(window: DateWindow): { after: number; before: number } {
  const at = Date.parse(window.at);
  const span = AROUND_SPAN_MS[window.span];
  return { after: at - span, before: at + span };
}

/**
 * Three parameters rather than one packed value: an ISO timestamp is full of colons, and a separator that has to
 * be escaped out of the one field it delimits is a parser waiting to go wrong.
 */
export function toWindowQuery(window: DateWindow | null): Record<string, string> {
  if (!window) return {};
  return { date: window.field, at: window.at, span: window.span };
}

/** The reverse. A window needs both a field and a moment that parses; anything less is no window at all. */
export function fromWindowQuery(raw: LocationQuery): DateWindow | null {
  const value = (key: string) => {
    const single = Array.isArray(raw[key]) ? (raw[key] as string[])[0] : raw[key];
    return typeof single === 'string' ? single : null;
  };
  const field = value('date');
  const at = value('at');
  if ((field !== 'modified' && field !== 'created') || !at || !Number.isFinite(Date.parse(at))) return null;
  const span = value('span');
  return { field, at, span: AROUND_SPANS.find((option) => option === span) ?? 'day' };
}
