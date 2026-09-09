<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import FileModals from './features/files/FileModals.vue';
import ItemMenuHost from './features/files/ItemMenuHost.vue';
import OperationsTray from './features/files/OperationsTray.vue';
import UploadTray from './features/files/UploadTray.vue';
import AppShell from './layout/AppShell.vue';
import { useSettingsStore } from './features/settings/settingsStore';
import { LOCALES, setLocale, type Locale } from './i18n';
import { useBrandingStore } from './stores/branding';
import { useCapabilitiesStore } from './stores/capabilities';
import { useFilesStore } from './stores/files';
import { useUploadStore } from './features/files/uploadStore';

const { locale } = useI18n();
const files = useFilesStore();
const settings = useSettingsStore();

watch(locale, (value) => (document.documentElement.lang = value), { immediate: true });
// The account carries the language and the time zone, so they follow the person to another browser. Local storage
// is what an offline or demo run falls back to; an account that has never set them leaves that choice standing.
void files.bootstrap().then(() => {
  const account = files.user;
  if (!account) return;
  if (account.locale && LOCALES.includes(account.locale as Locale)) setLocale(account.locale as Locale);
  if (account.timeZone) settings.apply({ ...settings.settings, timeZone: account.timeZone });
});
void useCapabilitiesStore().load();
// The operator's name, mark and accent. Public and pre-session on the server, so it does not wait on the account;
// the tab title follows it, which is the one piece of branding with nowhere else to show.
const branding = useBrandingStore();
void branding.load();
watch(() => branding.name, (name) => (document.title = name || 'filex'), { immediate: true });
// A reload leaves the server holding whatever a transfer had staged. Asking about those sessions is what turns
// them back into rows the person can carry on or throw away, instead of bytes that sit there until they expire.
void useUploadStore().restore();

// Screenshot / e2e URL hooks (`?view`, `?select`, `?panel`, `?modal`, `?menu`, `?demo`); dev builds only.
if (import.meta.env.DEV) void import('./dev/screenshotQuery').then(({ installScreenshotQuery }) => installScreenshotQuery());
</script>

<template>
  <AppShell>
    <RouterView />
    <!-- App-wide: the New menu (sidebar) and every page open these. Dialogs portal to <body>; the rest is fixed. -->
    <FileModals />
    <ItemMenuHost />
    <!-- One corner, two trays: a column so neither has to guess the other's height. Operations sit above the
         uploads — an upload is watched while it runs, an operation row is usually read after something went wrong. -->
    <div class="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-3">
      <OperationsTray />
      <UploadTray />
    </div>
  </AppShell>
</template>
