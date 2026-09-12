import { useI18n } from 'vue-i18n';
import { formatDate, formatDateTime, formatSize, formatTime } from '@/lib/format';

/** `lib/format` bound to the active locale and translator, so templates call `formatSize(bytes)` and the like. */
export function useFormat() {
  const { t, locale } = useI18n();
  return {
    formatSize: (bytes: number) => formatSize(bytes, t),
    formatDate: (iso: string | undefined) => formatDate(iso, locale.value),
    formatDateTime: (iso: string | undefined) => formatDateTime(iso, locale.value),
    formatTime: (iso: string) => formatTime(iso, locale.value),
  };
}
