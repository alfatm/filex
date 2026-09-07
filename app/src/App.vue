<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import FileModals from './features/files/FileModals.vue';
import ItemMenuHost from './features/files/ItemMenuHost.vue';
import UploadTray from './features/files/UploadTray.vue';
import AppShell from './layout/AppShell.vue';
import { useCapabilitiesStore } from './stores/capabilities';
import { useFilesStore } from './stores/files';

const { locale } = useI18n();
const files = useFilesStore();

watch(locale, (value) => (document.documentElement.lang = value), { immediate: true });
void files.bootstrap();
void useCapabilitiesStore().load();

// Screenshot / e2e URL hooks (`?view`, `?select`, `?panel`, `?modal`, `?menu`, `?demo`); dev builds only.
if (import.meta.env.DEV) void import('./dev/screenshotQuery').then(({ installScreenshotQuery }) => installScreenshotQuery());
</script>

<template>
  <AppShell>
    <RouterView />
    <!-- App-wide: the New menu (sidebar) and every page open these. Dialogs portal to <body>; the rest is fixed. -->
    <FileModals />
    <ItemMenuHost />
    <UploadTray />
  </AppShell>
</template>
