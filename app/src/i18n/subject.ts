/** The `t` overload used here; both `useI18n().t` and `i18n.global.t` satisfy it. */
type Translate = (key: string, named: Record<string, unknown>, plural?: number) => string;

/**
 * "“README.md” moved to trash" vs "3 items moved to trash". `${key}One` takes {name}; `${key}Many` pluralises
 * {count} — keeping them apart avoids locales whose plural rule maps 21 back onto the "one" form.
 */
export function subjectMessage(
  t: Translate,
  key: string,
  nodes: { name: string }[],
  extra: Record<string, unknown> = {},
): string {
  return nodes.length === 1
    ? t(`${key}One`, { ...extra, name: nodes[0].name })
    : t(`${key}Many`, { ...extra, count: nodes.length }, nodes.length);
}
