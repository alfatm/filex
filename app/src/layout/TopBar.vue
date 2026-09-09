<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
  ChevronDown,
  HelpCircle,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserRound,
} from 'lucide-vue-next';
import { emptyQuery, toUrlQuery, useSearchStore } from '@/features/search/searchStore';
import { joinPath, segments } from '@/lib/path';
import { THEMES, useSettingsStore } from '@/features/settings/settingsStore';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Avatar, IconButton } from '@/ui';
import FloatingMenu, { anchorBelow, type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

// Loaded on the first open, so the modal stays out of the initial bundle.
const AdvancedSearchModal = defineAsyncComponent(() => import('@/features/search/AdvancedSearchModal.vue'));

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const files = useFilesStore();
const search = useSearchStore();
const view = useViewStore();
const settings = useSettingsStore();
const capabilities = useCapabilitiesStore();

const accountMenu = ref<{ x: number; y: number } | null>(null);
const ACCOUNT_MENU_WIDTH = 208;

/**
 * Theme, one click away.
 *
 * It cycles rather than opening a menu: three states, and the one a person wants is almost always the next one.
 * The icon is the state it IS, not the state it would become — the button has to be readable when nobody is about
 * to press it, and the tooltip says both. Writes straight to the store, which applies and persists it; the
 * settings modal keeps a draft, but it covers this button while it is open, so the two cannot race.
 */
const THEME_ICONS = { light: Sun, system: Monitor, dark: Moon } as const;
const theme = computed(() => settings.settings.theme);
const nextTheme = computed(() => THEMES[(THEMES.indexOf(theme.value) + 1) % THEMES.length]);
const themeLabel = computed(() => t('topbar.theme', { current: t(`settings.theme.${theme.value}`), next: t(`settings.theme.${nextTheme.value}`) }));

/**
 * The admin panel, same origin: the backend serves this app under `/app/` and the console under `/admin/`.
 * Offered only to an admin — the panel's own guard sends everybody else back out, so a member would follow the
 * entry to a bounce. Over HTTP the server only ever says `admin` or `member`; the mock account is an `owner`.
 */
const ADMIN_SETTINGS_URL = '/admin/settings';
const isAdmin = computed(() => !!files.user && files.user.role !== 'member');

/** Signing out needs the session endpoint, so only the settings entries act for now. */
const accountItems = computed<FloatingMenuEntry[]>(() => [
  { id: 'settings', label: t('settings.title'), icon: UserRound },
  ...(isAdmin.value ? [{ id: 'adminSettings', label: t('topbar.adminSettings'), icon: ShieldCheck }] : []),
  { id: 'signOut', label: t('topbar.signOut'), icon: LogOut, dividerBefore: true, disabled: true, hint: t('common.comingSoon') },
]);

function onAccountSelect(id: string) {
  accountMenu.value = null;
  if (id === 'settings') settings.open = true;
  // A new tab: the console is a different application, and the person was in the middle of their files.
  else if (id === 'adminSettings') window.open(ADMIN_SETTINGS_URL, '_blank', 'noopener');
}

const input = ref<HTMLInputElement>();
const text = ref('');

/** Current-folder scope for the modal: the files route's path segments; elsewhere the query keeps its own. */
function currentFolderPath(): string | undefined {
  return route.name === 'files' ? joinPath(segments(route.params.path)) : undefined;
}

/** Enter runs a plain name/content search; every filter stays at its default. The sliders button opens the modal. */
function submitQuick() {
  const value = text.value.trim();
  if (!value) return;
  void router.push({ name: 'search', query: toUrlQuery({ ...emptyQuery(), text: value }) });
}

function openAdvanced() {
  search.openModal(text.value, currentFolderPath());
}

// Typing inside a field, an open menu or a dialog must not steal focus into the box.
function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]');
}

// ⌘K / Ctrl+K focuses the box from anywhere; a bare letter or digit typed outside an input does too.
function onKeydown(event: KeyboardEvent) {
  if (search.open) return;
  if (event.code === 'KeyK' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    input.value?.focus();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
  if (/^[\p{L}\p{N}]$/u.test(event.key)) input.value?.focus();
}

// The Sparkles trigger is hidden while the panel is open (spec §2 geometry), so focus lands on the box on close.
watch(
  () => view.assistantOpen,
  (open) => {
    if (!open) input.value?.focus();
  },
);

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <header class="flex h-[72px] shrink-0 items-center border-b border-border bg-bg pl-[42px] pr-8">
    <!-- Spec §2: the box ends at x 1180, or at x 962 while the assistant panel narrows the bar. -->
    <label
      class="flex h-12 flex-1 items-center rounded-xl bg-bg-muted pl-5 pr-5 focus-within:ring-2 focus-within:ring-primary-ring"
      :class="view.assistantOpen ? 'max-w-[640px]' : 'max-w-[858px]'"
    >
      <Search :size="20" class="shrink-0 text-text-3" />
      <input
        ref="input"
        v-model="text"
        type="search"
        class="min-w-0 flex-1 bg-transparent px-3 text-16 leading-none text-text placeholder:text-text-3 focus:outline-none"
        :placeholder="t('topbar.searchPlaceholder', { storage: files.storage?.name ?? '' })"
        :aria-label="t('nav.search')"
        @keydown.enter.prevent="submitQuick"
      />
      <IconButton :label="t('topbar.advancedSearch')" :size="32" class="mr-2 text-text-2" @click="openAdvanced">
        <SlidersHorizontal :size="18" />
      </IconButton>
      <span class="flex gap-1">
        <kbd class="flex h-6 w-6 items-center justify-center rounded-sm border border-border bg-bg text-12 leading-none text-text-2">⌘</kbd>
        <kbd class="flex h-6 w-6 items-center justify-center rounded-sm border border-border bg-bg text-12 leading-none text-text-2">K</kbd>
      </span>
    </label>

    <div class="ml-auto flex items-center gap-2 pl-6">
      <!-- The panel's own X closes it; hiding the trigger keeps the bar at the reference width while it is open. -->
      <IconButton v-if="!view.assistantOpen && capabilities.can.assistant" :label="t('topbar.assistant')" @click="view.assistantOpen = true">
        <Sparkles :size="22" :stroke-width="1.75" />
      </IconButton>
      <IconButton :label="themeLabel" @click="settings.settings.theme = nextTheme">
        <component :is="THEME_ICONS[theme]" :size="22" :stroke-width="1.75" />
      </IconButton>
      <IconButton :label="t('topbar.settings')" @click="settings.open = true"><Settings :size="22" :stroke-width="1.75" /></IconButton>
      <IconButton :label="t('topbar.help')" :disabled-hint="t('common.comingSoon')"><HelpCircle :size="22" :stroke-width="1.75" /></IconButton>
      <button
        type="button"
        class="ml-2 flex items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        :aria-label="t('topbar.account')"
        aria-haspopup="menu"
        :aria-expanded="!!accountMenu"
        @click="accountMenu = anchorBelow($event.currentTarget as HTMLElement, ACCOUNT_MENU_WIDTH)"
      >
        <Avatar :initial="files.user?.initial ?? ''" :src="files.user?.avatarUrl" />
        <ChevronDown :size="16" class="text-text-2" />
      </button>
      <FloatingMenu
        v-if="accountMenu"
        :items="accountItems"
        :x="accountMenu.x"
        :y="accountMenu.y"
        :width="ACCOUNT_MENU_WIDTH"
        :label="t('topbar.account')"
        @select="onAccountSelect"
        @close="accountMenu = null"
      />
    </div>

    <AdvancedSearchModal v-if="search.open" />
  </header>
</template>
