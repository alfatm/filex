import { describe, expect, it, vi } from 'vitest';
import { i18n, russianPlural } from './index';

describe('plural forms', () => {
  it('picks the Russian form by the last digits', () => {
    expect([0, 1, 2, 5, 11, 21, 22, 25, 111, 112].map(russianPlural)).toEqual([2, 0, 1, 2, 2, 0, 1, 2, 2, 2]);
  });

  it('renders item counts in every locale', () => {
    const t = (locale: 'en' | 'ru' | 'tr', n: number) => i18n.global.t('files.items', n, { locale });
    expect([t('en', 1), t('en', 8)]).toEqual(['1 item', '8 items']);
    expect([t('ru', 1), t('ru', 3), t('ru', 12), t('ru', 24)]).toEqual([
      '1 элемент',
      '3 элемента',
      '12 элементов',
      '24 элемента',
    ]);
    expect([t('tr', 1), t('tr', 8)]).toEqual(['1 öğe', '8 öğe']);
  });
});

// vue-i18n reads a bare `@` as the opening of a LINKED message (`@:other.key`),
// so `name@example.com` is not a plain string to it — it is a message with a
// broken link in it, and every AccessModal render printed three compilation
// errors per locale to stderr. The value is escaped with vue-i18n's literal
// syntax, `{'@'}`.
//
// The assertion has to be on the COMPILER, not on the output: the compiler
// recovers from the broken link and returns the address anyway, so the rendered
// text is the same either way and proves nothing on its own. It is checked too,
// because escaping must not leak `{'@'}` into what the person reads.
describe('literal @', () => {
  it('renders the access-modal email placeholder without compiling a linked message', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = (locale: 'en' | 'ru' | 'tr') =>
      i18n.global.t('modal.access.emailPlaceholder', {}, { locale });
    // One compile per locale, and only the first call for a locale compiles —
    // the message is cached after that, which is why this is the only place in
    // the suite that touches this key.
    const rendered = [t('en'), t('ru'), t('tr')];
    const complaints = errors.mock.calls.map((c) => String(c[0]));
    errors.mockRestore();

    expect(complaints).toEqual([]);
    // Turkish carries its own example address, not the English one.
    expect(rendered).toEqual(['name@example.com', 'name@example.com', 'ad@ornek.com']);
  });
});
