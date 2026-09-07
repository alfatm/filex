import { createI18n } from 'vue-i18n';
import en from '../locales/en.json';
import ru from '../locales/ru.json';
import tr from '../locales/tr.json';

export type Locale = 'en' | 'ru' | 'tr';
const SUPPORTED: Locale[] = ['en', 'ru', 'tr'];
const STORAGE_KEY = 'filex.app.locale';

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (SUPPORTED as string[]).includes(stored)) return stored as Locale;
  } catch {
    // storage may be unavailable (private mode); fall through to browser language
  }
  const browser = navigator.language.slice(0, 2).toLowerCase();
  return (SUPPORTED as string[]).includes(browser) ? (browser as Locale) : 'en';
}

/** Russian messages carry three forms: "one | few | many" (1 элемент | 2 элемента | 5 элементов). */
export function russianPlural(choice: number): number {
  const mod10 = choice % 10;
  const mod100 = choice % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return 2;
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'en',
  messages: { en, ru, tr },
  pluralRules: { ru: russianPlural },
});
