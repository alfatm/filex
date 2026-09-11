<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download, FolderInput, RotateCcw, Share2, Star, Trash2, X } from 'lucide-vue-next';
import { useModalsStore } from '@/features/files/modalsStore';
import { useFileActions } from '@/features/files/useFileActions';
import type { RolePermission } from '@/data/types';
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
  /** Why the action cannot be taken: the tooltip on a button that is disabled — the request would be refused. */
  hint?: string;
  run?: () => void;
}

/**
 * Two questions behind one inert button: the installation has to offer the action and the caller's ROLE has to
 * carry it, and the two say different things — "Not available on this server" against "Your role may not do this".
 */
function gate(supported: boolean, permission: RolePermission): string | undefined {
  if (!supported) return t('common.unavailable');
  return capabilities.allows(permission) ? undefined : t('common.notAllowed');
}

const allStarred = computed(() => files.selected.every((n) => n.starred));
/** A folder in the selection would need the zip endpoint, so the button stays inert for it. */
const hasFolder = computed(() => files.selected.some((n) => n.kind === 'folder'));

// Spec §7 actions; the trash listing swaps them for Restore / Delete forever.
const actions = computed<Action[]>(() =>
  files.listing?.kind === 'trash'
    ? [
        { id: 'restore', icon: RotateCcw, hint: gate(true, 'files.restore'), run: () => void files.restore(files.selected) },
        {
          id: 'deleteForever',
          icon: Trash2,
          hint: gate(capabilities.can.deleteForever, 'files.purge'),
          run: () => modals.open({ kind: 'delete', variant: 'forever', nodes: files.selected }),
        },
      ]
    : [
        {
          id: 'download',
          icon: Download,
          hint: gate(!hasFolder.value || capabilities.can.folderDownload, 'files.download'),
          run: () => fileActions.download(files.selected),
        },
        {
          id: 'share',
          icon: Share2,
          disabled: files.selected.length !== 1,
          hint: gate(true, 'files.share'),
          run: () => modals.open({ kind: 'share', node: files.selected[0] }),
        },
        { id: 'move', icon: FolderInput, hint: gate(capabilities.can.move, 'files.move'), run: () => modals.open({ kind: 'move', nodes: files.selected }) },
        {
          id: allStarred.value ? 'unstar' : 'star',
          icon: Star,
          hint: gate(true, 'files.star'),
          run: () => void files.setStarred(files.selected, !allStarred.value),
        },
        {
          id: 'delete',
          icon: Trash2,
          hint: gate(capabilities.can.delete, 'files.delete'),
          run: () => modals.open({ kind: 'delete', variant: 'trash', nodes: files.selected }),
        },
      ],
);
</script>

<template>
  <!-- Spec §7. Takes the filter row's slot so the table header stays put. -->
  <div
    class="flex h-control-md items-center gap-0.5 rounded-md bg-primary-soft pl-3 pr-1"
    role="toolbar"
    :aria-label="t('selection.count', { count: files.selected.length })"
  >
    <span class="mr-2 text-12 font-medium leading-none">{{ t('selection.count', { count: files.selected.length }) }}</span>
    <IconButton
      v-for="action in actions"
      :key="action.id"
      :label="t(`selection.${action.id}`)"
      :size="28"
      class="text-text-2 hover:bg-primary-tint disabled:opacity-40 disabled:hover:bg-transparent"
      :disabled="action.disabled || !!action.hint"
      :disabled-hint="action.hint"
      @click="action.run?.()"
    >
      <component :is="action.icon" :size="16" :fill="action.id === 'unstar' ? 'currentColor' : 'none'" />
    </IconButton>
    <IconButton :label="t('selection.clear')" :size="28" class="ml-auto text-text-2 hover:bg-primary-tint" @click="files.clearSelection()">
      <X :size="16" />
    </IconButton>
  </div>
</template>
