import { describe, expect, it } from 'vitest';
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
