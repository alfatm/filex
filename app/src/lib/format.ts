import type { Composer } from 'vue-i18n';

const BASE = 1024;
const UNIT_KEYS = ['unit.b', 'unit.kb', 'unit.mb', 'unit.gb'] as const;

/**
 * "2.4 KB", "12 MB", "568 KB" — one decimal only when it is non-zero; the unit
 * is chosen after rounding so 1023.99 KB reads "1 MB", not "1024 KB".
 */
/** A node whose source records no date at all — a storage root has none. Better an em dash than 1 Jan 1970. */
const NO_DATE = '\u2014';

export function formatSize(bytes: number, t: Composer['t']): string {
  // Bytes are whole; larger units keep one decimal.
  const round = (value: number, unit: number) => (unit === 0 ? Math.round(value) : Math.round(value * 10) / 10);
  let value = bytes;
  let unit = 0;
  while (unit < UNIT_KEYS.length - 1 && round(value, unit) >= BASE) {
    value /= BASE;
    unit++;
  }
  const rounded = round(value, unit);
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} ${t(UNIT_KEYS[unit])}`;
}

/** English keeps the spec's 12-hour clock with a leading zero ("09:12 AM"); other locales use their own convention (24h). */
function clockOptions(locale: string): Intl.DateTimeFormatOptions {
  return { hour: '2-digit', minute: '2-digit', ...(locale.startsWith('en') && { hour12: true }) };
}

/** "Jul 8, 2026, 11:24 AM", "Jul 1, 2026, 09:12 AM"; ru "8 июл. 2026 г., 15:14". */
export function formatDateTime(iso: string | undefined, locale: string): string {
  if (!iso) return NO_DATE;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', ...clockOptions(locale) }).format(
    new Date(iso),
  );
}

/** "Jul 10, 2026" */
export function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return NO_DATE;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

/** "10:24 AM" (ru/tr "10:24") — the clock shown under chat bubbles. */
export function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, clockOptions(locale)).format(new Date(iso));
}

/** Local calendar day as "YYYY-MM-DD"; the Recent page groups rows by it. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", otherwise "Jul 5, 2026" — relative to `now` in local time. */
export function formatRelativeDay(iso: string | undefined, locale: string, t: Composer['t'], now = new Date()): string {
  if (!iso) return NO_DATE;
  const day = dayKey(iso);
  if (day === dayKey(now.toISOString())) return t('date.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayKey(yesterday.toISOString())) return t('date.yesterday');
  return formatDate(iso, locale);
}
