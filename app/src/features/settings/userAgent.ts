/**
 * A session row has to say WHICH device it is, and all the server can record is the user agent string. This
 * turns the common ones into something a person can recognise ("Chrome · macOS") and says nothing at all when
 * it cannot tell — a guess here would be a device the user goes looking for and does not own.
 */
const BROWSERS: [needle: string, name: string][] = [
  // Order matters: Edge and Opera both carry "Chrome", and Chrome carries "Safari".
  ['Edg/', 'Edge'],
  ['OPR/', 'Opera'],
  ['Chrome/', 'Chrome'],
  ['Firefox/', 'Firefox'],
  ['Safari/', 'Safari'],
];

const SYSTEMS: [needle: string, name: string][] = [
  ['iPhone', 'iPhone'],
  ['iPad', 'iPad'],
  ['Android', 'Android'],
  ['Windows', 'Windows'],
  ['Mac OS X', 'macOS'],
  ['Linux', 'Linux'],
];

function match(ua: string, table: [string, string][]): string {
  return table.find(([needle]) => ua.includes(needle))?.[1] ?? '';
}

/** "Chrome · macOS", or as much of it as the string supports; "" when it supports neither half. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  return [match(ua, BROWSERS), match(ua, SYSTEMS)].filter(Boolean).join(' · ');
}
