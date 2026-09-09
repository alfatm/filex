import type { App } from 'vue';
import { i18n } from '@/i18n';
import { useToastStore } from '@/stores/toast';

/** What a caught `unknown` says, for a field or a line that has to show something. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The last resort for a failure nobody else answered for.
 *
 * It is a net, not a substitute for handling: a place that knows what the person was trying to do says so where
 * they were trying to do it. What lands here is what would otherwise have reached nobody at all — a rejected
 * promise in a watcher, a throw inside a render — and a toast is the least this app may say about it.
 */
export function reportUnhandled(error: unknown) {
  console.error(error);
  useToastStore().push(i18n.global.t('error.unexpected'));
}

export function installErrorSink(app: App) {
  app.config.errorHandler = (error) => reportUnhandled(error);
  window.addEventListener('unhandledrejection', (event) => reportUnhandled(event.reason));
}
