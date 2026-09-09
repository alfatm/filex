<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, watch } from 'vue';
import { repository } from '@/data';
import { useDragStore } from '@/features/files/dragStore';
import { useSettingsStore } from '@/features/settings/settingsStore';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import Sidebar from './Sidebar.vue';
import ToastHost from './ToastHost.vue';
import TopBar from './TopBar.vue';

// Loaded on first open: the panel and its store are not part of the initial bundle.
const AssistantPanel = defineAsyncComponent(() => import('@/features/assistant/AssistantPanel.vue'));
const SettingsModal = defineAsyncComponent(() => import('@/features/settings/SettingsModal.vue'));

const view = useViewStore();
const settings = useSettingsStore();
const files = useFilesStore();
const drag = useDragStore();

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
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden bg-bg text-text">
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
    <ToastHost />
  </div>
</template>
