<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, useRoute } from 'vue-router';
import {
  Cable,
  ChevronDown,
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
import type { RolePermission } from '@/data/types';
import { filesRoute } from '@/lib/path';
import { useModalsStore } from '@/features/files/modalsStore';
import { useUploadStore } from '@/features/files/uploadStore';
import { useFormat } from '@/composables/useFormat';
import { useBrandingStore } from '@/stores/branding';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Button, IconButton, ProgressBar } from '@/ui';
import FloatingMenu, { type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

const { t, locale } = useI18n();
const baseUrl = import.meta.env.BASE_URL;
const { formatSize } = useFormat();
const route = useRoute();
const files = useFilesStore();
const capabilities = useCapabilitiesStore();
// The operator's mark and name stand in for filex's own when this installation is branded.
const branding = useBrandingStore();
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

/**
 * "My files" is the home drive, so it is active for THAT drive and not for "some files route".
 *
 * Its link resolves to `/files` with no drive in it, which vue-router's own active test reads as an ancestor of
 * every `/files/...` — so the row painted itself while the listing was on a completely different mount. The drive
 * rows below already compare the drive, and this is the same comparison, against the drive that link actually
 * opens: the store's `homeStorageId`, not the `main` constant, which an installation need not have mounted at all.
 */
function isNavActive(name: (typeof nav)[number]['name']): boolean {
  if (name !== 'files') return route.name === name;
  return route.name === 'files' && files.storage?.id === files.homeStorageId;
}

// Both screens mount shared components that ask the deployment about itself — the real host, the caller's login,
// the storage names. Against the mock there is nothing to ask, so the entries stay inert there.
const connections = [
  { name: 'connect', icon: Cable, label: 'nav.howToConnect' },
  { name: 'apiKeys', icon: KeyRound, label: 'nav.apiKeys' },
] as const;

/**
 * Both halves of the question, with a sentence each: an installation that cannot do it says "Not available on this
 * server", a role that may not do it says "Your role may not do this".
 */
function gate(supported: boolean, permission: RolePermission) {
  if (!supported) return { disabled: true, hint: t('common.unavailable') };
  if (!capabilities.allows(permission)) return { disabled: true, hint: t('common.notAllowed') };
  return {};
}

// Creating comes first, bringing something in second; the divider is the line between the two.
const newItems = computed<FloatingMenuEntry[]>(() => [
  { id: 'folder', label: t('new.folder'), icon: FolderPlus, ...gate(capabilities.can.mkdir, 'files.mkdir') },
  { id: 'file', label: t('new.file'), icon: FilePlus, ...gate(capabilities.can.upload, 'files.upload') },
  { id: 'fileUpload', label: t('new.fileUpload'), icon: Upload, dividerBefore: true, ...gate(capabilities.can.upload, 'files.upload') },
  { id: 'folderUpload', label: t('new.folderUpload'), icon: FolderUp, ...gate(capabilities.can.upload, 'files.upload') },
]);

/**
 * The other two ways an account can be full, on one line under the bar.
 *
 * The bar measures BYTES HELD, and an upload refused for the file count or for the rolling upload window is not
 * explained by a bar that is half empty — so each ceiling that exists says where it stands. A ceiling the account
 * does not have is left out rather than printed as "unlimited", which is a row about nothing.
 */
const quotaLimits = computed(() => {
  const quota = files.storage?.quota;
  if (!quota) return '';
  const count = (n: number) => n.toLocaleString(locale.value);
  const parts: string[] = [];
  if (quota.totalFiles) parts.push(t('quota.files', { used: count(quota.usedFiles), total: count(quota.totalFiles) }));
  if (quota.uploadTotalBytes) {
    parts.push(
      t('quota.uploadWindow', {
        used: formatSize(quota.uploadUsedBytes),
        total: formatSize(quota.uploadTotalBytes),
        hours: quota.uploadWindowHours,
      }),
    );
  }
  return parts.join(' · ');
});

const newMenu = ref<{ x: number; y: number } | null>(null);
const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const NEW_MENU_GAP = 6;

/**
 * The logo reloads the app, the way the logo of a web app usually does.
 *
 * A real reload rather than a route change plus a refetch: what somebody clicks it for is to start over from a
 * state they no longer trust, and only a reload rebuilds every store from scratch.
 */
function reload() {
  window.location.reload();
}

function openNewMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  newMenu.value = { x: rect.left, y: rect.bottom + NEW_MENU_GAP };
}

function onNewSelect(id: string) {
  newMenu.value = null;
  if (id === 'folder') modals.open({ kind: 'newFolder' });
  else if (id === 'file') modals.open({ kind: 'newFile' });
  else if (id === 'fileUpload') fileInput.value?.click();
  else if (id === 'folderUpload') folderInput.value?.click();
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) void uploads.start(input.files);
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
      <!--
        The mark and the name are one control: clicking them reloads the app. Its accessible name is the visible
        name rather than an aria-label, so what a person says out loud to a voice control is what they can read; the
        tooltip carries what the click does. Geometry is unchanged — the `ml-6` that spaced the mark from the
        hamburger moved onto the button, so nothing in the reference shifts.
      -->
      <button
        v-if="!view.sidebarCollapsed"
        type="button"
        :title="t('nav.reload')"
        class="ml-6 flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        @click="reload"
      >
        <img :src="branding.logoUrl || `${baseUrl}logo.svg`" alt="" class="h-8 w-8 object-contain" />
        <span class="ml-4 text-22 font-semibold leading-none">{{ branding.name || t('app.name') }}</span>
      </button>
    </div>

    <!-- Same left edge (x 14) as the active nav pill below; the button's own icon and label are centred inside it. -->
    <div class="mt-[10px]" :class="view.sidebarCollapsed ? '' : 'pl-[14px]'">
      <Button
        :size="view.sidebarCollapsed ? 'md' : 'lg'"
        :class="view.sidebarCollapsed ? '!h-11 !w-11 !rounded-full !px-0' : 'w-[180px] !gap-0 !px-0'"
        aria-haspopup="menu"
        :aria-expanded="!!newMenu"
        :aria-label="view.sidebarCollapsed ? t('new.button') : undefined"
        @click="openNewMenu"
      >
        <Plus v-if="view.sidebarCollapsed" :size="20" />
        <template v-else>
          <!-- The ref centres icon and label inside the button rather than aligning them to the nav columns below. -->
          <span class="flex flex-1 items-center justify-center gap-[26px] font-semibold">
            <Plus :size="20" />
            {{ t('new.button') }}
          </span>
          <!-- One control, not two: the divider says a menu is behind the button, and both halves open the same one.
               It is a short centred rule in the ref, not a full-height edge. -->
          <span class="h-7 w-px bg-white/25" />
          <span class="flex w-11 items-center justify-center">
            <ChevronDown :size="18" />
          </span>
        </template>
      </Button>
      <FloatingMenu v-if="newMenu" :items="newItems" :x="newMenu.x" :y="newMenu.y" :label="t('new.button')" @select="onNewSelect" @close="newMenu = null" />
      <!-- Native pickers behind the "Upload files" and "Upload folder" entries; the second one hands us a flat
           list whose files carry `webkitRelativePath`, which the upload store turns back into folders. -->
      <input ref="fileInput" type="file" multiple class="hidden" tabindex="-1" :aria-label="t('new.fileUpload')" @change="onFilesPicked" />
      <input ref="folderInput" type="file" webkitdirectory multiple class="hidden" tabindex="-1" :aria-label="t('new.folderUpload')" @change="onFilesPicked" />
    </div>

    <div class="min-h-0 overflow-y-auto" :class="view.sidebarCollapsed && 'w-full'">
      <ul class="mt-[22px] flex flex-col gap-px" :class="view.sidebarCollapsed ? 'items-center' : 'pl-[14px] pr-5'">
        <li v-for="item in nav" :key="item.name">
          <RouterLink
            :to="{ name: item.name }"
            :class="[linkClass, isNavActive(item.name) && activeClass]"
            :title="view.sidebarCollapsed ? t(item.label) : undefined"
          >
            <component :is="item.icon" :size="20" :stroke-width="1.75" class="shrink-0" />
            <span :class="view.sidebarCollapsed && 'sr-only'">{{ t(item.label) }}</span>
          </RouterLink>
        </li>
      </ul>

      <!-- The home drive is "My files" above, so a section that would list only it is left out altogether. -->
      <template v-if="files.listedStorages.length">
        <p v-if="!view.sidebarCollapsed" :class="captionClass">{{ t('nav.storages') }}</p>
        <!-- The caption's place in rail mode: a rule, so the groups stay apart without a label. -->
        <div v-else class="mx-auto mt-[22px] h-px w-8 bg-border" />
      </template>
      <ul class="mt-2 flex flex-col gap-px" :class="view.sidebarCollapsed ? 'items-center' : 'pl-[14px] pr-5'">
        <!--
          Active is the drive the listing is actually in, not "some files route": the condition used to be the
          route name alone, so with a second drive on the sidebar BOTH rows painted themselves active.
        -->
        <li v-for="storage in files.listedStorages" :key="storage.id">
          <RouterLink
            :to="filesRoute(storage.id, [])"
            :class="[linkClass, route.name === 'files' && files.storage?.id === storage.id && activeClass]"
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
        <li v-for="item in connections" :key="item.name">
          <RouterLink
            v-if="capabilities.can.connections"
            :to="{ name: item.name }"
            :class="[linkClass, route.name === item.name && activeClass]"
            :title="view.sidebarCollapsed ? t(item.label) : undefined"
          >
            <component :is="item.icon" :size="20" :stroke-width="1.75" class="shrink-0" />
            <span :class="view.sidebarCollapsed && 'sr-only'">{{ t(item.label) }}</span>
          </RouterLink>
          <button
            v-else
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
      <p class="text-15 font-semibold leading-none">
        {{ files.storage.id === files.homeStorageId ? t('storage.home', { name: files.storage.name }) : files.storage.name }}
      </p>
      <p class="mt-1.5 text-13 leading-none text-text-3">
        {{
          files.storage.quota.totalBytes
            ? t('quota.used', {
                used: formatSize(files.storage.quota.usedBytes),
                total: formatSize(files.storage.quota.totalBytes),
              })
            : t('quota.usedUnlimited', { used: formatSize(files.storage.quota.usedBytes) })
        }}
      </p>
      <p v-if="quotaLimits" class="mt-1.5 text-13 leading-tight text-text-3">{{ quotaLimits }}</p>
      <!-- An account with no ceiling has nothing to fill, so it gets the figure without the bar. -->
      <ProgressBar
        v-if="files.storage.quota.totalBytes"
        class="mt-2.5"
        :value="files.storage.quota.usedBytes"
        :max="files.storage.quota.totalBytes"
        :width="234"
      />
    </div>
  </nav>
</template>
