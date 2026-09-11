<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { repository } from '@/data';
import { useDragStore } from '@/features/files/dragStore';
import { useSettingsStore } from '@/features/settings/settingsStore';
import { useUploadStore } from '@/features/files/uploadStore';
import { LOCALES, setLocale, type Locale } from '@/i18n';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import SessionExpiredModal from './SessionExpiredModal.vue';
import Sidebar from './Sidebar.vue';
import ToastHost from './ToastHost.vue';
import TopBar from './TopBar.vue';

// Loaded on first open: the panel and its store are not part of the initial bundle.
const AssistantPanel = defineAsyncComponent(() => import('@/features/assistant/AssistantPanel.vue'));
const SettingsModal = defineAsyncComponent(() => import('@/features/settings/SettingsModal.vue'));

const { t } = useI18n();
const view = useViewStore();
const settings = useSettingsStore();
const files = useFilesStore();
const drag = useDragStore();
const capabilities = useCapabilitiesStore();

/*
 * Start-up that needs an account, and therefore lives HERE rather than in App.vue: the shell is the part of the
 * app that only exists once somebody is signed in, so mounting it is the moment these are worth asking for. From
 * App.vue they also ran on the sign-in screen, where every one of them is a 401.
 */

// The account carries the language and the time zone, so they follow the person to another browser. Local storage
// is what an offline or demo run falls back to; an account that has never set them leaves that choice standing.
void files.bootstrap().then(() => {
  const account = files.user;
  if (!account) return;
  if (account.locale && LOCALES.includes(account.locale as Locale)) setLocale(account.locale as Locale);
  if (account.timeZone) settings.apply({ ...settings.settings, timeZone: account.timeZone });
});
void capabilities.load();
// A snapshot that never arrived leaves every action reading "Not available on this server" for the rest of the
// session; coming back online is the one moment worth asking again.
window.addEventListener('online', () => {
  if (capabilities.failed) void capabilities.load();
});
// A reload leaves the server holding whatever a transfer had staged. Asking about those sessions is what turns
// them back into rows the person can carry on or throw away, instead of bytes that sit there until they expire.
void useUploadStore().restore();

/**
 * The drive list, again, after anything changed the files.
 *
 * It carries how much each drive holds, and the shell is what draws that figure — the sidebar's quota block and
 * Home's drive cards read the same store. Read once at start-up it never moved again: an upload, a delete and an
 * emptied trash all left the bar exactly where it had been when the app opened.
 */
watch(
  () => files.revision,
  async () => {
    try {
      files.storages = await repository.listStorages();
    } catch {
      // The figures stay as they were; the listing's own error path owns telling anybody the server is unreachable.
    }
  },
);

/**
 * How many elements deep the pointer is during a drag.
 *
 * `dragleave` is the only sign that a drag has left the window, and it fires on every element the pointer crosses
 * on the way out too — so the enter/leave pairs are counted rather than any one of them believed.
 */
let depth = 0;

function onWindowDragEnter() {
  depth++;
}

/**
 * The window's own answer to a file dragged in from the OS.
 *
 * A browser handed a file it was not offered navigates AWAY to it, losing whatever the person was doing — and only
 * the folder view had a drop zone, so that is what a miss did on Home, Recent, Starred, Shared, Trash and Search.
 * Anything the page took keeps the effect it chose; the rest is refused here rather than by the browser.
 */
function onWindowDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  drag.files = true;
  if (event.defaultPrevented) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'none';
}

/**
 * Back to zero: the drag is gone. There is no `dragend` for one that started outside the browser, and without this
 * the "files are being dragged" flag stayed on for the rest of the session — the next drag INSIDE the app then lit
 * up every folder as a valid target, the folder being dragged included.
 */
function onWindowDragLeave() {
  if (--depth > 0) return;
  depth = 0;
  // Only the OS drag needs this: one that started in the app ends on its own source's `dragend`.
  if (drag.files) drag.end();
}

function onWindowDrop(event: DragEvent) {
  depth = 0;
  drag.end();
  if (!event.defaultPrevented) event.preventDefault();
}

onMounted(() => {
  window.addEventListener('dragenter', onWindowDragEnter);
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('dragleave', onWindowDragLeave);
  window.addEventListener('drop', onWindowDrop);
});
onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onWindowDragEnter);
  window.removeEventListener('dragover', onWindowDragOver);
  window.removeEventListener('dragleave', onWindowDragLeave);
  window.removeEventListener('drop', onWindowDrop);
});

/**
 * Where "skip" lands: the listing itself when the page has one — it is a single keyboard scope with its own
 * arrows — and otherwise the page's `main`, which is made focusable for the occasion.
 */
function skipToContent() {
  const main = document.querySelector('main');
  const listing = main?.querySelector<HTMLElement>('[role="grid"], [role="listbox"]');
  if (listing) return listing.focus();
  if (!main) return;
  main.tabIndex = -1;
  main.focus();
}
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden bg-bg text-text">
    <!-- The first tab stop on every page. The shell's chrome — sidebar, header, breadcrumb, filters, sort — is
         thirty-odd stops deep, so without this a keyboard-only person walked all of it before reaching a single
         file. Off-screen until it takes focus. -->
    <button
      type="button"
      class="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-bg focus:px-3 focus:py-2 focus:text-13 focus:shadow-menu focus:ring-2 focus:ring-primary-ring"
      @click="skipToContent"
    >
      {{ t('nav.skipToContent') }}
    </button>
    <Sidebar />
    <div class="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <!-- Pages own this area: content column plus the optional details panel. -->
      <div class="flex min-h-0 flex-1">
        <slot />
      </div>
    </div>
    <!-- Full height beside the topbar (spec §6: header at the topbar's level, search box shrinks). -->
    <AssistantPanel v-if="view.assistantOpen" @close="view.assistantOpen = false" />
    <SettingsModal v-if="settings.open" />
    <!-- The cookie ran out: raised by the HTTP client, shown here because a lost session is the shell's news and
         never the sign-in screen's. -->
    <SessionExpiredModal />
    <ToastHost />
  </div>
</template>
