/**
 * The config the shared `@brftech/filex-core` components take.
 *
 * "How to connect" and "API keys" are not written here: they exist once, in the package, and the admin panel and
 * the desktop app mount the same files. This module is only the adapter — who is calling, and which theme and
 * language to render in.
 */
import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AuthConfig, ExplorerConfig, LocaleCode } from '@brftech/filex-core';
import { useSettingsStore } from '@/features/settings/settingsStore';

/**
 * Who is calling.
 *
 * The app is a signed-in surface on the server's own origin, so the session cookie is already on every request;
 * what the components additionally need is the CSRF token filex pairs with it. `none` is honest when there is no
 * cookie — the panel then shows the server's 401 rather than pretending.
 */
function auth(): AuthConfig {
  const prefix = 'filex_csrf=';
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return { kind: 'csrf', csrf: decodeURIComponent(trimmed.slice(prefix.length)) };
  }
  return { kind: 'none' };
}

/**
 * The config, following the app's own theme and language.
 *
 * The package takes a RESOLVED theme, and the app's "system" writes no `data-theme` at all — tokens.css follows
 * `prefers-color-scheme` by itself — so that case is answered here or the panel stays light inside a dark app.
 * Language: the package has catalogues for en and tr only and falls back on its own, so a ru reader gets English
 * inside these two screens.
 */
export function useCoreConfig(): ComputedRef<ExplorerConfig> {
  const { locale } = useI18n();
  const settings = useSettingsStore();
  return computed(() => ({
    // Same origin: the server that serves this app serves the API.
    apiBase: '',
    endpoint: '/api/files/manager',
    auth: auth(),
    theme:
      settings.settings.theme === 'system'
        ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : settings.settings.theme,
    locale: locale.value as LocaleCode,
  }));
}
