<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
  ArrowLeft,
  ChevronDown,
  HelpCircle,
  LogOut,
  Monitor,
  Moon,
  Menu as MenuIcon,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  UserRound,
} from 'lucide-vue-next';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { emptyQuery, fromUrlQuery, toUrlQuery, useSearchStore } from '@/features/search/searchStore';
import { joinPath, segments } from '@/lib/path';
import { THEMES, useSettingsStore } from '@/features/settings/settingsStore';
import { useAuthStore } from '@/stores/auth';
import { useBrandingStore } from '@/stores/branding';
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
const auth = useAuthStore();
const branding = useBrandingStore();
const baseUrl = import.meta.env.BASE_URL;

/**
 * On a phone the sidebar is not in the layout at all (spec §10), so the brand moves HERE — and the three icon
 * buttons that would no longer fit beside it move into the account menu. Without this a phone carried no product
 * name anywhere on screen.
 */
const { isMobile } = useBreakpoint();

/**
 * The phone's search (spec §10): an icon, and the field takes the whole bar once it is asked for.
 *
 * A 390px bar cannot hold a menu button, a brand, a search field and an account at once — the field was the one
 * that lost, down to about a hundred pixels with a placeholder nobody could read.
 */
const searchOpen = ref(false);

/**
 * The mode where the field has the whole bar. Asked for by the icon — and forced on the results route, because
 * there the field IS the query: collapsed, it left the page with nothing to edit the search in and no way out of
 * it, since the control that leaves lives in the bar the field takes over.
 */
const searchFull = computed(() => isMobile.value && (searchOpen.value || route.name === 'search'));

/**
 * Where the back arrow goes: the route the search was STARTED from, not a step of history. Every refinement
 * pushes another `/search` entry, so `back()` would walk the previous queries one at a time instead of leaving
 * the search at all — and a shared `/search?q=…` link has nothing behind it to go back to, hence the fallback.
 */
const searchOrigin = ref<string | null>(null);

async function openSearch() {
  searchOrigin.value = route.fullPath;
  searchOpen.value = true;
  await nextTick();
  input.value?.focus();
}

function closeSearch() {
  searchOpen.value = false;
  if (route.name === 'search') void router.push(searchOrigin.value ?? { name: 'home' });
}

function reload() {
  window.location.reload();
}

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
 * The trigger, when there is something behind it: the server has to offer an assistant AND this browser has to
 * have it switched on. Gated on the server alone, the button still opened a panel that the setting closes again
 * the moment it appears.
 */
const assistantOffered = computed(() => !view.assistantOpen && capabilities.can.assistant && settings.settings.assistantEnabled);

/**
 * The admin panel, same origin: the backend serves this app at the root and the console under `/admin/`.
 * Offered only to an admin — the panel's own guard sends everybody else back out, so a member would follow the
 * entry to a bounce. Over HTTP the server only ever says `admin` or `member`; the mock account is an `owner`.
 */
const ADMIN_SETTINGS_URL = '/admin/settings';
const isAdmin = computed(() => !!files.user && files.user.role !== 'member');

const accountItems = computed<FloatingMenuEntry[]>(() => [
  /*
   * The three themes as a choice, not the bar's cycling button carried over: that button's label is a whole
   * sentence ("Theme: Dark. Switch to Light") because it has to explain a cycle to somebody hovering one icon —
   * in a menu it wrapped onto two lines and said what the NEXT press would do instead of what this entry does.
   * A menu can show all three and tick the one in force.
   */
  ...(isMobile.value
    ? [
        ...THEMES.map((id) => ({
          id: `theme:${id}`,
          label: t(`settings.theme.${id}`),
          icon: THEME_ICONS[id],
          checked: theme.value === id,
        })),
        { id: 'help', label: t('topbar.help'), icon: HelpCircle, dividerBefore: true, disabled: true, hint: t('common.comingSoon') },
      ]
    : []),
  { id: 'settings', label: t('settings.title'), icon: UserRound },
  ...(isAdmin.value ? [{ id: 'adminSettings', label: t('topbar.adminSettings'), icon: ShieldCheck }] : []),
  { id: 'signOut', label: t('topbar.signOut'), icon: LogOut, dividerBefore: true },
]);

function onAccountSelect(id: string) {
  accountMenu.value = null;
  if (id.startsWith('theme:')) settings.settings.theme = id.slice('theme:'.length) as (typeof THEMES)[number];
  else if (id === 'settings') settings.open = true;
  // A new tab: the console is a different application, and the person was in the middle of their files.
  else if (id === 'adminSettings') window.open(ADMIN_SETTINGS_URL, '_blank', 'noopener');
  // Ends the session and reloads onto the sign-in screen — the store's own doing, because nothing of this
  // account's may be left in memory for whoever signs in next on this browser.
  else if (id === 'signOut') void auth.signOut();
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

/**
 * The URL owns the query, so the box follows it: `/search?q=…` has to arrive with its text in the field, and the
 * modal's own submit has to show up here too. Only the results route writes back — everywhere else the box keeps
 * whatever was typed into it.
 */
watch(
  () => [route.name, route.query] as const,
  () => {
    if (route.name === 'search') text.value = fromUrlQuery(route.query).text;
  },
  { immediate: true },
);

/**
 * The native clear (the X in a `type="search"` box) only empties the input. On the results page that left the
 * hits and chips of a query nothing was asking for any more, so clearing drops the query from the URL as well —
 * the page reads it from there.
 */
function onClear() {
  if (text.value.trim() || route.name !== 'search') return;
  void router.push({ name: 'search', query: {} });
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
  // Somebody nearer the key already used it. This listens on the window, so it runs after every handler in the
  // page: the listing's own `r` (refresh) reached here too, and the letter that refreshed the folder also threw
  // focus into the search box, where the next arrow key and the next Delete then went.
  if (event.defaultPrevented) return;
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
  <header class="flex h-12 shrink-0 items-center border-b border-border bg-bg pl-4 pr-3">
    <!-- The rail below `xl` cannot carry the brand, so it stands here instead — one control that reloads the app,
         exactly as it is in the sidebar. The phone keeps the plain search bar until the search itself becomes an
         icon (spec §10); a brand beside a full-width field would leave neither of them room. -->
    <!-- `-ml-2` cancels the bar's own `pl-4` down to the 8 the sidebar's row uses, and the glyph is the sidebar's
         18: the drawer this opens draws the same button and the same brand a few pixels away, and two geometries
         for one control make the whole header jump as the drawer slides over it. -->
    <IconButton
      v-if="isMobile && !searchFull"
      :label="t('nav.openMenu')"
      class="-ml-2 mr-1 text-text"
      @click="view.drawerOpen = true"
    >
      <MenuIcon :size="18" :stroke-width="1.75" />
    </IconButton>
    <!-- Back, not a cross at the far end of the bar: the control belongs to the search it leaves, and on a phone
         that is what the gesture is — one step back out of a mode, the same as the breadcrumb's arrow. -->
    <IconButton
      v-if="searchFull"
      :label="t('topbar.closeSearch')"
      class="-ml-2 mr-1 text-text"
      @click="closeSearch"
    >
      <ArrowLeft :size="18" :stroke-width="1.75" />
    </IconButton>
    <button
      v-if="isMobile && !searchFull"
      type="button"
      :title="t('nav.reload')"
      class="mr-3 flex shrink-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
      @click="reload"
    >
      <img :src="branding.logoUrl || `${baseUrl}logo.svg`" alt="" class="h-7 w-7 object-contain" />
      <!-- 18, as in the sidebar (§2): on a phone the same brand is drawn in two places — here, and in the drawer
           the menu button opens — and two sizes for one name reads as two different things. -->
      <span class="ml-2 text-18 font-semibold leading-none">{{ branding.name || t('app.name') }}</span>
    </button>
    <!-- Capped rather than full-bleed: a search field the width of the window reads as a page, not a control.
         The cap narrows again while the assistant panel is open. -->
    <label
      v-if="!isMobile || searchFull"
      class="flex h-control-md flex-1 items-center rounded-md bg-bg-muted pl-3 pr-2 focus-within:ring-2 focus-within:ring-primary-ring"
      :class="isMobile ? '' : view.assistantOpen ? 'max-w-[560px]' : 'max-w-[760px]'"
    >
      <Search :size="16" class="shrink-0 text-text-3" />
      <input
        ref="input"
        v-model="text"
        type="search"
        class="min-w-0 flex-1 bg-transparent px-2 text-13 leading-none text-text placeholder:text-text-3 focus:outline-none"
        :placeholder="t('topbar.searchPlaceholder', { storage: files.storage?.name ?? '' })"
        :aria-label="t('nav.search')"
        @keydown.enter.prevent="submitQuick"
        @search="onClear"
      />
      <IconButton :label="t('topbar.advancedSearch')" :size="28" class="mr-1 text-text-2" @click="openAdvanced">
        <SlidersHorizontal :size="16" />
      </IconButton>
      <span v-if="!isMobile" class="flex gap-1">
        <kbd class="flex h-5 w-5 items-center justify-center rounded-sm border border-border bg-bg text-10 leading-none text-text-2">⌘</kbd>
        <kbd class="flex h-5 w-5 items-center justify-center rounded-sm border border-border bg-bg text-10 leading-none text-text-2">K</kbd>
      </span>
    </label>

    <div v-if="!searchFull" class="ml-auto flex items-center gap-0.5 pl-3">
      <IconButton v-if="isMobile" :label="t('nav.search')" @click="openSearch">
        <Search :size="18" :stroke-width="1.75" />
      </IconButton>
      <!-- The panel's own X closes it; hiding the trigger keeps the bar at the reference width while it is open. -->
      <IconButton v-if="assistantOffered" :label="t('topbar.assistant')" @click="view.assistantOpen = true">
        <Sparkles :size="18" :stroke-width="1.75" />
      </IconButton>
      <!-- On a phone these three are entries in the account menu instead: the bar has the brand to carry now. -->
      <template v-if="!isMobile">
        <IconButton :label="themeLabel" @click="settings.settings.theme = nextTheme">
          <component :is="THEME_ICONS[theme]" :size="18" :stroke-width="1.75" />
        </IconButton>
        <IconButton :label="t('topbar.settings')" @click="settings.open = true"><Settings :size="18" :stroke-width="1.75" /></IconButton>
        <IconButton :label="t('topbar.help')" :disabled-hint="t('common.comingSoon')"><HelpCircle :size="18" :stroke-width="1.75" /></IconButton>
      </template>
      <button
        type="button"
        class="ml-1 flex items-center gap-0.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
        :aria-label="t('topbar.account')"
        aria-haspopup="menu"
        :aria-expanded="!!accountMenu"
        @click="accountMenu = anchorBelow($event.currentTarget as HTMLElement, ACCOUNT_MENU_WIDTH)"
      >
        <Avatar :initial="files.user?.initial ?? ''" :src="files.user?.avatarUrl" />
        <ChevronDown :size="14" class="text-text-2" />
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
