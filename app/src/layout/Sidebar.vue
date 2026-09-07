<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';
import {
  Cable,
  Clock,
  FilePlus,
  Folder,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  KeyRound,
  Menu as MenuIcon,
  Plus,
  Star,
  Trash2,
  Upload,
  Users,
} from 'lucide-vue-next';
import { useModalsStore } from '@/features/files/modalsStore';
import { useUploadStore } from '@/features/files/uploadStore';
import { useFormat } from '@/composables/useFormat';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Button, IconButton, ProgressBar } from '@/ui';
import FloatingMenu, { type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

const { t } = useI18n();
const { formatSize } = useFormat();
const route = useRoute();
const files = useFilesStore();
const view = useViewStore();
const modals = useModalsStore();
const uploads = useUploadStore();

const nav = [
  { name: 'home', icon: Home, label: 'nav.home' },
  { name: 'files', icon: Folder, label: 'nav.files' },
  { name: 'shared', icon: Users, label: 'nav.shared' },
  { name: 'recent', icon: Clock, label: 'nav.recent' },
  { name: 'starred', icon: Star, label: 'nav.starred' },
  { name: 'trash', icon: Trash2, label: 'nav.trash' },
] as const;

const connections = [
  { id: 'howToConnect', icon: Cable, label: 'nav.howToConnect' },
  { id: 'apiKeys', icon: KeyRound, label: 'nav.apiKeys' },
] as const;

// Folder upload needs the sub-folder chain created from `webkitRelativePath`; until then the entry is disabled.
const newItems = computed<FloatingMenuEntry[]>(() => [
  { id: 'folder', label: t('new.folder'), icon: FolderPlus },
  { id: 'fileUpload', label: t('new.fileUpload'), icon: Upload },
  { id: 'folderUpload', label: t('new.folderUpload'), icon: FolderUp, disabled: true, hint: t('common.comingSoon') },
  { id: 'document', label: t('new.document'), icon: FilePlus, dividerBefore: true, disabled: true, hint: t('common.comingSoon') },
]);

const newMenu = ref<{ x: number; y: number } | null>(null);
const fileInput = ref<HTMLInputElement>();
const NEW_MENU_GAP = 6;

function openNewMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  newMenu.value = { x: rect.left, y: rect.bottom + NEW_MENU_GAP };
}

function onNewSelect(id: string) {
  newMenu.value = null;
  if (id === 'folder') modals.open({ kind: 'newFolder' });
  else if (id === 'fileUpload') fileInput.value?.click();
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) uploads.start(input.files);
  input.value = '';
}

// Spec §2: items span x 14..260; the active one paints that box.
// Rail mode keeps the same rows and paints the same active box; only the labels and the section captions go.
const itemClass = computed(() =>
  view.sidebarCollapsed
    ? 'flex h-10 w-10 items-center justify-center rounded-md text-16 font-medium leading-none text-text'
    : 'flex h-10 items-center gap-[26px] rounded-md pl-[10px] pr-3 text-16 font-medium leading-none text-text',
);
const linkClass = computed(() => `${itemClass.value} hover:bg-bg-muted`);
const activeClass = 'bg-primary-soft';
const captionClass = 'mt-[34px] px-[26px] text-12 font-semibold uppercase leading-[18px] tracking-[.06em] text-text-3';
</script>

<template>
  <nav
    class="flex h-full shrink-0 flex-col border-r border-border bg-bg-sidebar"
    :class="view.sidebarCollapsed ? 'w-[76px] items-center' : 'w-[280px]'"
  >
    <div class="flex h-[72px] items-center" :class="view.sidebarCollapsed ? 'justify-center' : 'pl-5'">
      <IconButton
        :label="t(view.sidebarCollapsed ? 'nav.expandMenu' : 'nav.collapseMenu')"
        class="text-text"
        :aria-expanded="!view.sidebarCollapsed"
        @click="view.sidebarCollapsed = !view.sidebarCollapsed"
      >
        <MenuIcon :size="22" :stroke-width="1.75" />
      </IconButton>
      <template v-if="!view.sidebarCollapsed">
        <span class="ml-6 flex h-8 w-8 items-center justify-center rounded bg-primary text-white">
          <Folder :size="18" fill="currentColor" :stroke-width="0" />
        </span>
        <span class="ml-4 text-22 font-semibold leading-none">{{ t('app.name') }}</span>
      </template>
    </div>

    <!-- Same left edge, icon column and label column as the nav rows below, so the sidebar reads as one column. -->
    <div class="mt-[10px]" :class="view.sidebarCollapsed ? '' : 'pl-[14px]'">
      <Button
        :size="view.sidebarCollapsed ? 'md' : 'lg'"
        :class="view.sidebarCollapsed ? '!h-11 !w-11 !rounded-full !px-0' : 'w-[136px] !justify-start gap-[26px] !pl-[10px] !pr-4'"
        aria-haspopup="menu"
        :aria-expanded="!!newMenu"
        :aria-label="view.sidebarCollapsed ? t('new.button') : undefined"
        @click="openNewMenu"
      >
        <Plus :size="20" />
        <span v-if="!view.sidebarCollapsed">{{ t('new.button') }}</span>
      </Button>
      <FloatingMenu v-if="newMenu" :items="newItems" :x="newMenu.x" :y="newMenu.y" :label="t('new.button')" @select="onNewSelect" @close="newMenu = null" />
      <!-- Native picker behind the "File upload" entry. -->
      <input ref="fileInput" type="file" multiple class="hidden" tabindex="-1" :aria-label="t('new.fileUpload')" @change="onFilesPicked" />
    </div>

    <div class="min-h-0 overflow-y-auto" :class="view.sidebarCollapsed && 'w-full'">
      <ul class="mt-[22px] flex flex-col gap-px" :class="view.sidebarCollapsed ? 'items-center' : 'pl-[14px] pr-5'">
        <li v-for="item in nav" :key="item.name">
          <RouterLink :to="{ name: item.name }" :class="linkClass" :active-class="activeClass" :title="view.sidebarCollapsed ? t(item.label) : undefined">
            <component :is="item.icon" :size="20" :stroke-width="1.75" class="shrink-0" />
            <span :class="view.sidebarCollapsed && 'sr-only'">{{ t(item.label) }}</span>
          </RouterLink>
        </li>
      </ul>

      <p v-if="!view.sidebarCollapsed" :class="captionClass">{{ t('nav.storages') }}</p>
      <!-- The caption's place in rail mode: a rule, so the groups stay apart without a label. -->
      <div v-else class="mx-auto mt-[22px] h-px w-8 bg-border" />
      <ul class="mt-2 flex flex-col gap-px" :class="view.sidebarCollapsed ? 'items-center' : 'pl-[14px] pr-5'">
        <li v-for="storage in files.storages" :key="storage.id">
          <RouterLink
            :to="{ name: 'storage', params: { id: storage.id } }"
            :class="[linkClass, route.name === 'files' && activeClass]"
            :title="view.sidebarCollapsed ? storage.name : undefined"
          >
            <HardDrive :size="20" :stroke-width="1.75" class="shrink-0" />
            <span :class="view.sidebarCollapsed && 'sr-only'">{{ storage.name }}</span>
          </RouterLink>
        </li>
      </ul>

      <p v-if="!view.sidebarCollapsed" :class="[captionClass, '!mt-[26px]']">{{ t('nav.connections') }}</p>
      <div v-else class="mx-auto mt-[22px] h-px w-8 bg-border" />
      <ul class="mt-2 flex flex-col gap-px" :class="view.sidebarCollapsed ? 'items-center' : 'pl-[14px] pr-5'">
        <li v-for="item in connections" :key="item.id">
          <button
            type="button"
            :class="[itemClass, view.sidebarCollapsed ? 'cursor-default' : 'w-full cursor-default']"
            aria-disabled="true"
            :title="view.sidebarCollapsed ? `${t(item.label)} — ${t('common.comingSoon')}` : t('common.comingSoon')"
          >
            <component :is="item.icon" :size="20" :stroke-width="1.75" class="shrink-0" />
            <span :class="view.sidebarCollapsed && 'sr-only'">{{ t(item.label) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- The quota block needs its labels; the rail drops it rather than showing a bar with no numbers. -->
    <div v-if="files.storage && !view.sidebarCollapsed" class="mt-auto shrink-0 pb-[34px] pl-[26px] pt-6">
      <p class="text-15 font-semibold leading-none">{{ files.storage.name }}</p>
      <p class="mt-1.5 text-13 leading-none text-text-3">
        {{
          t('quota.used', {
            used: formatSize(files.storage.quota.usedBytes),
            total: formatSize(files.storage.quota.totalBytes),
          })
        }}
      </p>
      <ProgressBar
        class="mt-2.5"
        :value="files.storage.quota.usedBytes"
        :max="files.storage.quota.totalBytes"
        :width="234"
      />
    </div>
  </nav>
</template>
