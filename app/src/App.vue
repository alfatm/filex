<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import FileModals from './features/files/FileModals.vue';
import ItemMenuHost from './features/files/ItemMenuHost.vue';
import OperationsTray from './features/files/OperationsTray.vue';
import UploadTray from './features/files/UploadTray.vue';
import AppShell from './layout/AppShell.vue';
import ToastHost from './layout/ToastHost.vue';
import { useBrandingStore } from './stores/branding';

const { locale } = useI18n();
const route = useRoute();

watch(locale, (value) => (document.documentElement.lang = value), { immediate: true });
// The operator's name, mark and accent. Public and pre-session on the server, so it does not wait on the account —
// which is also what lets the sign-in screen carry the operator's logo before anybody is signed in. The tab title
// follows it, which is the one piece of branding with nowhere else to show.
const branding = useBrandingStore();
void branding.load();
watch(() => branding.name, (name) => (document.title = name || 'filex'), { immediate: true });

/**
 * The sign-in screen stands alone: no sidebar, no topbar, and none of the account-shaped start-up the shell does
 * (the drives, the capability snapshot, the staged uploads) — every one of those is a request the server answers
 * 401 to when there is nobody signed in. AppShell owns that work now, so it happens exactly when the shell does.
 *
 * ⚠ The FIRST navigation is still pending when the app mounts, and until it resolves the route is vue-router's
 * start location: no name, no meta, and therefore not public. Without the name check the shell mounted there and
 * bootstrapped against a server that had not been asked who this is yet — on a cold load at a folder URL that is
 * a 401, which leaves the drive list empty and `ready` true. Signing in remounts the shell, but `ready` is what
 * the folder page waits on: it opened the address against an empty drive list, and the second bootstrap then
 * cleared the failure it had raised. The address was right and the folder was blank until a reload.
 */
const shell = computed(() => route.name !== undefined && !route.meta.public);
</script>

<template>
  <AppShell v-if="shell">
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
  <template v-else>
    <RouterView />
    <!-- The sign-in screen has no shell to host them, and it still has things to say (a failed hand-off back from
         the identity provider is the one that matters). -->
    <ToastHost />
  </template>
</template>
