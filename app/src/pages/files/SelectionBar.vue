<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Copy, Download, FolderInput, MoreVertical, RotateCcw, Share2, Star, Trash2, X } from 'lucide-vue-next';
import { useModalsStore } from '@/features/files/modalsStore';
import { useFileActions } from '@/features/files/useFileActions';
import type { RolePermission } from '@/data/types';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { IconButton } from '@/ui';
import FloatingMenu, { anchorBelow } from '@/ui/FloatingMenu.vue';

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
        // The row menu has offered "Copy to" all along; the selection bar did not, so the one thing a person could
        // not do to several files at once was duplicate them. Same modal, same verb, same permission.
        { id: 'copy', icon: Copy, hint: gate(capabilities.can.copy, 'files.copy'), run: () => modals.open({ kind: 'copy', nodes: files.selected }) },
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

/**
 * A phone fits three of these beside the count and the clear button; the seventh was drawn off the edge of the
 * bar, where nothing could reach it. The rest move into a ⋮ — the same actions, one tap further away (spec §10).
 */
const { isMobile } = useBreakpoint();
const PHONE_ACTIONS = 3;
const OVERFLOW_MENU_WIDTH = 208;
const shown = computed(() => (isMobile.value ? actions.value.slice(0, PHONE_ACTIONS) : actions.value));
const overflow = computed(() => (isMobile.value ? actions.value.slice(PHONE_ACTIONS) : []));
const menu = ref<{ x: number; y: number } | null>(null);

const overflowItems = computed(() =>
  overflow.value.map((action) => ({
    id: action.id,
    label: t(`selection.${action.id}`),
    icon: action.icon,
    disabled: action.disabled || !!action.hint,
    hint: action.hint,
  })),
);

function onOverflowSelect(id: string) {
  menu.value = null;
  overflow.value.find((action) => action.id === id)?.run?.();
}
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
      v-for="action in shown"
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
    <IconButton
      v-if="overflow.length"
      :label="t('files.more')"
      :size="28"
      class="text-text-2 hover:bg-primary-tint"
      aria-haspopup="menu"
      @click="menu = anchorBelow($event.currentTarget as HTMLElement, OVERFLOW_MENU_WIDTH)"
    >
      <MoreVertical :size="16" />
    </IconButton>
    <FloatingMenu
      v-if="menu"
      :items="overflowItems"
      :x="menu.x"
      :y="menu.y"
      :width="OVERFLOW_MENU_WIDTH"
      :label="t('files.more')"
      @select="onOverflowSelect"
      @close="menu = null"
    />
    <IconButton :label="t('selection.clear')" :size="28" class="ml-auto text-text-2 hover:bg-primary-tint" @click="files.clearSelection()">
      <X :size="16" />
    </IconButton>
  </div>
</template>
