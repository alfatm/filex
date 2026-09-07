import { describe, expect, it } from 'vitest';
import type { Composer } from 'vue-i18n';
import { formatDate, formatDateTime, formatSize, formatRelativeDay, formatTime } from './format';

const units: Record<string, string> = { 'unit.b': 'B', 'unit.kb': 'KB', 'unit.mb': 'MB', 'unit.gb': 'GB' };
const t = ((key: string) => units[key] ?? key) as Composer['t'];
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** ICU may emit narrow no-break spaces before AM/PM; the spec only cares about the visible text. */
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');

describe('formatSize', () => {
  it('formats with one decimal only when needed', () => {
    expect(formatSize(2.4 * KB, t)).toBe('2.4 KB');
    expect(formatSize(12 * MB, t)).toBe('12 MB');
    expect(formatSize(568 * KB, t)).toBe('568 KB');
    expect(formatSize(12.6 * MB, t)).toBe('12.6 MB');
    expect(formatSize(500, t)).toBe('500 B');
  });

  it('handles unit boundaries after rounding', () => {
    expect(formatSize(0, t)).toBe('0 B');
    expect(formatSize(1023, t)).toBe('1023 B');
    expect(formatSize(1024, t)).toBe('1 KB');
    expect(formatSize(1023.94 * KB, t)).toBe('1023.9 KB');
    expect(formatSize(1023.99 * KB, t)).toBe('1 MB');
    expect(formatSize(1023.99 * MB, t)).toBe('1 GB');
    expect(formatSize(2048 * GB, t)).toBe('2048 GB');
  });
});

describe('formatDateTime', () => {
  it('renders the spec format in en', () => {
    expect(plain(formatDateTime('2026-07-08T11:24:00', 'en'))).toBe('Jul 8, 2026, 11:24 AM');
    expect(plain(formatDateTime('2026-07-01T09:12:00', 'en'))).toBe('Jul 1, 2026, 09:12 AM');
    expect(plain(formatDateTime('2026-07-05T09:41:00', 'en'))).toBe('Jul 5, 2026, 09:41 AM');
    expect(plain(formatDateTime('2026-07-08T15:14:00', 'en'))).toBe('Jul 8, 2026, 03:14 PM');
    expect(formatDate('2026-07-10T12:06:00', 'en')).toBe('Jul 10, 2026');
  });

  it('uses the 24-hour clock in ru and tr', () => {
    expect(plain(formatDateTime('2026-07-08T15:14:00', 'ru'))).toBe('8 июл. 2026 г., 15:14');
    expect(plain(formatDateTime('2026-07-01T09:12:00', 'ru'))).toBe('1 июл. 2026 г., 09:12');
    expect(plain(formatDateTime('2026-07-08T15:14:00', 'tr'))).toBe('8 Tem 2026 15:14');
    expect(plain(formatDateTime('2026-07-01T09:12:00', 'tr'))).toBe('1 Tem 2026 09:12');
  });
});

describe('formatTime', () => {
  it('follows the same clock per locale', () => {
    expect(plain(formatTime('2026-07-10T10:24:00', 'en'))).toBe('10:24 AM');
    expect(plain(formatTime('2026-07-10T15:14:00', 'en'))).toBe('03:14 PM');
    expect(plain(formatTime('2026-07-10T15:14:00', 'ru'))).toBe('15:14');
    expect(plain(formatTime('2026-07-10T09:12:00', 'tr'))).toBe('09:12');
  });
});

describe('formatRelativeDay', () => {
  const now = new Date('2026-07-10T15:00:00');
  const t = ((key: string) => ({ 'date.today': 'Today', 'date.yesterday': 'Yesterday' })[key] ?? key) as Composer['t'];

  it('says Today / Yesterday by local calendar day, else the date', () => {
    expect(formatRelativeDay('2026-07-10T00:30:00', 'en', t, now)).toBe('Today');
    expect(formatRelativeDay('2026-07-09T23:59:00', 'en', t, now)).toBe('Yesterday');
    expect(formatRelativeDay('2026-07-08T23:59:00', 'en', t, now)).toBe('Jul 8, 2026');
    expect(formatRelativeDay('2026-07-05T09:41:00', 'en', t, now)).toBe('Jul 5, 2026');
  });

  it('crosses month and year boundaries', () => {
    expect(formatRelativeDay('2026-06-30T12:00:00', 'en', t, new Date('2026-07-01T08:00:00'))).toBe('Yesterday');
    expect(formatRelativeDay('2025-12-31T12:00:00', 'en', t, new Date('2026-01-01T08:00:00'))).toBe('Yesterday');
  });
});
