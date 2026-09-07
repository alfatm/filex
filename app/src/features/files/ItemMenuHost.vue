<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { itemMenuEntries, listingMenuEntries } from '@/pages/files/itemMenu';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import FloatingMenu from '@/ui/FloatingMenu.vue';
import { useClipboardStore } from './clipboardStore';
import { MENU_WIDTH, useItemMenuStore } from './itemMenuStore';
import { useModalsStore } from './modalsStore';
import { useUploadStore } from './uploadStore';
import { useFileActions } from './useFileActions';

const { t } = useI18n();
const menu = useItemMenuStore();
const files = useFilesStore();
const { can } = storeToRefs(useCapabilitiesStore());
const modals = useModalsStore();
const clipboard = useClipboardStore();
const uploads = useUploadStore();
const actions = useFileActions();

const fileInput = ref<HTMLInputElement>();

const entries = computed(() => {
  if (!menu.state) return [];
  if (menu.state.node) return itemMenuEntries(t, menu.state.node, can.value);
  return listingMenuEntries(t, can.value, {
    canCreate: files.listing?.kind === 'folder',
    canPaste: clipboard.canPaste,
    canSelectAll: files.ordered.length > 0,
    hasSelection: files.selected.length > 0,
  });
});

const label = computed(() => (menu.state?.node ? t('files.more') : t('files.listingActions')));

function onSelect(id: string) {
  const node = menu.state?.node;
  menu.close();
  if (node) return void actions.run(id, node);
  if (id === 'newFolder') modals.open({ kind: 'newFolder' });
  else if (id === 'paste') void clipboard.paste();
  else if (id === 'fileUpload') fileInput.value?.click();
  else if (id === 'selectAll') files.selectAll();
  else if (id === 'clearSelection') files.clearSelection();
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) void uploads.start(input.files);
  input.value = '';
}
</script>

<template>
  <FloatingMenu
    v-if="menu.state"
    :items="entries"
    :x="menu.state.x"
    :y="menu.state.y"
    :width="MENU_WIDTH"
    :label="label"
    @select="onSelect"
    @close="menu.close()"
  />
  <!-- Native picker behind the menu's "File upload"; the sidebar's New button has its own. -->
  <input ref="fileInput" type="file" multiple class="hidden" tabindex="-1" :aria-label="t('new.fileUpload')" @change="onFilesPicked" />
</template>
