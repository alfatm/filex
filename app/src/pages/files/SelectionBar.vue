<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download, FolderInput, RotateCcw, Share2, Star, Trash2, X } from 'lucide-vue-next';
import { useModalsStore } from '@/features/files/modalsStore';
import { useFileActions } from '@/features/files/useFileActions';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { IconButton } from '@/ui';

const { t } = useI18n();
const files = useFilesStore();
const modals = useModalsStore();
const fileActions = useFileActions();
const capabilities = useCapabilitiesStore();

interface Action {
  id: string;
  icon: typeof Download;
  disabled?: boolean;
  /** Inert entry ("Coming soon"): aria-disabled with this tooltip, not dimmed. */
  hint?: string;
  run?: () => void;
}

const allStarred = computed(() => files.selected.every((n) => n.starred));
/** A folder in the selection would need the zip endpoint, so the button stays inert for it. */
const hasFolder = computed(() => files.selected.some((n) => n.kind === 'folder'));

// Spec §7 actions; the trash listing swaps them for Restore / Delete forever.
const actions = computed<Action[]>(() =>
  files.listing?.kind === 'trash'
    ? [
        { id: 'restore', icon: RotateCcw, run: () => void files.restore(files.selected) },
        {
          id: 'deleteForever',
          icon: Trash2,
          hint: capabilities.can.deleteForever ? undefined : t('common.unavailable'),
          run: () => modals.open({ kind: 'delete', variant: 'forever', nodes: files.selected }),
        },
      ]
    : [
        {
          id: 'download',
          icon: Download,
          hint: hasFolder.value && !capabilities.can.folderDownload ? t('common.unavailable') : undefined,
          run: () => fileActions.download(files.selected),
        },
        {
          id: 'share',
          icon: Share2,
          disabled: files.selected.length !== 1,
          run: () => modals.open({ kind: 'share', node: files.selected[0] }),
        },
        { id: 'move', icon: FolderInput, run: () => modals.open({ kind: 'move', nodes: files.selected }) },
        { id: allStarred.value ? 'unstar' : 'star', icon: Star, run: () => void files.setStarred(files.selected, !allStarred.value) },
        { id: 'delete', icon: Trash2, run: () => modals.open({ kind: 'delete', variant: 'trash', nodes: files.selected }) },
      ],
);
</script>

<template>
  <!-- Spec §7. Takes the filter row's slot so the table header stays put. -->
  <div
    class="flex h-12 items-center gap-1 rounded-md bg-primary-soft pl-4 pr-1"
    role="toolbar"
    :aria-label="t('selection.count', { count: files.selected.length })"
  >
    <span class="mr-3 text-15 font-medium leading-none">{{ t('selection.count', { count: files.selected.length }) }}</span>
    <IconButton
      v-for="action in actions"
      :key="action.id"
      :label="t(`selection.${action.id}`)"
      :size="36"
      class="text-text-2 hover:bg-primary-tint disabled:opacity-40 disabled:hover:bg-transparent"
      :disabled="action.disabled"
      :disabled-hint="action.hint"
      @click="action.run?.()"
    >
      <component :is="action.icon" :size="20" :fill="action.id === 'unstar' ? 'currentColor' : 'none'" />
    </IconButton>
    <IconButton :label="t('selection.clear')" :size="36" class="ml-auto text-text-2 hover:bg-primary-tint" @click="files.clearSelection()">
      <X :size="20" />
    </IconButton>
  </div>
</template>
