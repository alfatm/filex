<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { Bell, ChevronRight, Folder, KeyRound, Monitor, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-vue-next';
import { repository } from '@/data';
import { INVALID_CODE, MIN_PASSWORD_LENGTH, WRONG_PASSWORD } from '@/data/repository';
import type { AuthMethods, Node, NotifyPrefs, Session, TotpEnrollment } from '@/data/types';
import { useToastStore } from '@/stores/toast';
import { LOCALES, setLocale, type Locale } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';
import { Avatar, Button, Input, Select } from '@/ui';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { useFormat } from '@/composables/useFormat';
import Segmented from './Segmented.vue';
import SettingRow from './SettingRow.vue';
import Toggle from './Toggle.vue';
import { deviceLabel } from './userAgent';
import { ASSISTANT_MODE_VALUES, CONFLICT_BEHAVIORS, THEMES, TIME_ZONES, useSettingsStore, type Settings } from './settingsStore';

/** The nav is a vertical tab strip: one item, one panel, nothing else rendered. */
const SECTIONS = [
  { id: 'profile', icon: UserRound },
  { id: 'preferences', icon: Settings2 },
  { id: 'notifications', icon: Bell },
  { id: 'security', icon: ShieldCheck },
  { id: 'assistant', icon: Sparkles },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];


/** The picture is stored inline on the account, so it is downscaled to a thumbnail before it is ever sent. */
const AVATAR_PX = 160;
const AVATAR_QUALITY = 0.85;
/** How long a Copy button reads "Copied" before it offers to copy again. */
const COPIED_MS = 1500;

/** What the sentence says where a ceiling is absent; the row still states what is HELD, which is the useful half. */
const UNLIMITED = '∞';

const { t, te, locale } = useI18n();
const { formatDate, formatSize } = useFormat();
const files = useFilesStore();

/** The account's three ceilings as the drive reports them; absent until a drive has been listed. */
const quota = computed(() => files.storage?.quota ?? null);
const pair = (used: string, total: string) => t('settings.storage.outOf', { used, total });
const quotaBytes = computed(() =>
  quota.value ? pair(formatSize(quota.value.usedBytes), quota.value.totalBytes ? formatSize(quota.value.totalBytes) : UNLIMITED) : '',
);
const quotaFiles = computed(() =>
  quota.value
    ? pair(quota.value.usedFiles.toLocaleString(locale.value), quota.value.totalFiles ? quota.value.totalFiles.toLocaleString(locale.value) : UNLIMITED)
    : '',
);
const quotaUpload = computed(() =>
  quota.value ? pair(formatSize(quota.value.uploadUsedBytes), quota.value.uploadTotalBytes ? formatSize(quota.value.uploadTotalBytes) : UNLIMITED) : '',
);
const view = useViewStore();
const store = useSettingsStore();
const toast = useToastStore();

// The modal edits a copy: Cancel just drops it, Save commits everything at once.
const draft = ref<Settings>({ ...store.settings });
/**
 * The account's own fields, kept apart from `draft` because they have a different destination: these go to the
 * server and follow the person to another browser, while `draft` is what this browser remembers.
 */
const profile = ref({ fullName: '', displayName: '', jobTitle: '' });
/** Null until the server answers — an install with notifications switched off has no matrix to show. */
const notify = ref<NotifyPrefs | null>(null);
const language = ref<Locale>(locale.value as Locale);
const active = ref<SectionId>('profile');
// The picture belongs to the ACCOUNT, not to the local settings, so it is drafted on its own.
const avatarUrl = ref('');
const photoInput = ref<HTMLInputElement>();
const tabs = ref<Record<string, HTMLButtonElement>>({});
const saving = ref(false);

/**
 * The Security section asks the server how this account signs in before it offers anything: a password form on an
 * OIDC realm could only ever fail, and the second factor belongs to whatever provider the realm names.
 */
const auth = ref<AuthMethods | null>(null);
const passwordOpen = ref(false);
const passwordBusy = ref(false);
const passwordError = ref('');
const currentPassword = ref('');
const newPassword = ref('');
const repeatPassword = ref('');

/**
 * The second-factor panel, opening in place like the password form. `enroll` shows the QR and asks for the first
 * code, `recovery` the codes that come with a confirmed enrolment, `disable` asks for the password and a code.
 */
const totpPanel = ref<'enroll' | 'recovery' | 'disable' | null>(null);
const totpBusy = ref(false);
const totpError = ref('');
const enrollment = ref<TotpEnrollment | null>(null);
const totpCode = ref('');
const totpPassword = ref('');
/** Which Copy button just did its job; its label says so for a moment. */
const copied = ref<'secret' | 'codes' | null>(null);

/**
 * Where this account is signed in. Null while it is unknown — an older server has no `/api/auth/sessions` — and
 * the row then says nothing rather than an invented "0 sessions".
 */
const sessions = ref<Session[] | null>(null);
const sessionsOpen = ref(false);
const sessionsError = ref('');

const providerLabel = computed(() => {
  const key = `settings.security.provider.${auth.value?.provider ?? ''}`;
  return te(key) ? t(key) : t('settings.security.provider.unknown');
});

/** On a realm that owns the password, the row names that realm instead of offering a change it cannot make. */
const passwordStatus = computed(() => (auth.value?.changePassword ? t('settings.security.passwordHint') : providerLabel.value));

const secondFactorOn = computed(() => auth.value?.provider === 'local' && auth.value.totpEnabled);

/** The second factor in one word: filex's own TOTP on a local realm, otherwise the provider's business. */
const secondFactorLabel = computed(() => {
  if (!auth.value) return '';
  if (auth.value.provider !== 'local') return t('settings.security.twoFactorProvider');
  return auth.value.totpEnabled ? t('settings.security.twoFactorOn') : t('settings.security.twoFactorOff');
});
const panel = ref<{ $el: HTMLElement } | null>(null);
const panelEl = computed(() => panel.value?.$el ?? undefined);

const nav = computed(() => SECTIONS.map((s) => ({ ...s, label: t(`settings.nav.${s.id}`) })));
const languageOptions = computed(() => LOCALES.map((value) => ({ value, label: t(`settings.languages.${value}`) })));
const themeOptions = computed(() => THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) })));
const conflictOptions = computed(() => CONFLICT_BEHAVIORS.map((value) => ({ value, label: t(`settings.conflict.${value}`) })));
const modeOptions = computed(() => ASSISTANT_MODE_VALUES.map((value) => ({ value, label: t(`assistant.mode.${value}`) })));

/** "(GMT-8) Los Angeles" — the offset comes from the browser, the city from the zone id. */
function zoneLabel(zone: string): string {
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return `(${parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'}) ${city}`;
  } catch {
    return city;
  }
}

const zoneOptions = computed(() => {
  const zones = TIME_ZONES.includes(draft.value.timeZone) ? TIME_ZONES : [draft.value.timeZone, ...TIME_ZONES];
  return zones.map((value) => ({ value, label: zoneLabel(value) }));
});

/**
 * The default-upload-folder select, a LEVEL at a time.
 *
 * `trail` is the chain from the drive root down to the chosen folder and `level` is what sits inside the chosen
 * one; picking a folder drills into it, picking one of its ancestors comes back up to it. Filling this list by
 * walking the whole drive was one request per folder, paid on every open of the modal, for a list of which two or
 * three entries were ever looked at — the destination picker stopped doing that and so does this.
 */
const trail = ref<Node[]>([]);
const level = ref<Node[]>([]);
let foldersAsked = false;
/** Two no-break spaces per level: an <option> cannot be indented any other way. */
const INDENT = '\u00a0\u00a0';

const folderOptions = computed(() => [
  { value: '', label: t('nav.files') },
  ...trail.value.map((node, depth) => ({ value: node.id, label: INDENT.repeat(depth + 1) + node.name })),
  ...level.value.map((node) => ({ value: node.id, label: INDENT.repeat(trail.value.length + 1) + node.name })),
]);

async function loadLevel() {
  const id = trail.value.at(-1)?.id ?? files.storage?.rootId;
  level.value = id ? await repository.listSubfolders(id).catch(() => []) : [];
}

/** Opening Preferences is what pays for the first level — and for resolving the folder that was saved. */
async function openFolders() {
  if (foldersAsked) return;
  foldersAsked = true;
  const saved = draft.value.defaultUploadFolder;
  if (saved) {
    try {
      const [node, chain] = await Promise.all([repository.getNode(saved), repository.getPath(saved)]);
      // The drive root is the "" option rather than a folder in the trail.
      trail.value = [...chain.filter((n) => n.parentId !== null), node];
    } catch {
      // ⚠ A node id here IS a path, so renaming the folder leaves a setting that names nothing. The select falls
      // back to the drive root and saying "Save changes" makes that the setting, instead of a dead id kept for ever.
      draft.value.defaultUploadFolder = '';
    }
  }
  await loadLevel();
}

async function pickFolder(id: string) {
  draft.value.defaultUploadFolder = id;
  const at = trail.value.findIndex((n) => n.id === id);
  if (!id) trail.value = [];
  else if (at >= 0) trail.value = trail.value.slice(0, at + 1);
  else {
    const node = level.value.find((n) => n.id === id);
    if (node) trail.value = [...trail.value, node];
  }
  await loadLevel();
}

// Nothing is fetched until the panel holding the select is actually looked at.
watch(active, (id) => {
  if (id === 'preferences') void openFolders();
});

const displayName = computed(() => profile.value.displayName || files.user?.name || '');

onMounted(async () => {
  auth.value = await repository.authMethods();
  // The switches are the account's, so what they show has to come from the account rather than from a default.
  try {
    notify.value = await repository.notifyPrefs();
  } catch {
    notify.value = null;
  }
  // The count is part of the collapsed row, so the list is fetched with the rest of the Security answer.
  try {
    sessions.value = await repository.listSessions();
  } catch {
    sessions.value = null;
  }
});

/** Ending a session takes effect immediately: it is not part of the draft "Save changes" commits. */
async function endSession(id: string) {
  sessionsError.value = '';
  try {
    await repository.revokeSession(id);
  } catch {
    sessionsError.value = t('settings.security.sessionsFailed');
    return;
  }
  sessions.value = (sessions.value ?? []).filter((session) => session.id !== id);
}

function openPassword() {
  closeTotp();
  passwordOpen.value = true;
  passwordError.value = '';
  currentPassword.value = newPassword.value = repeatPassword.value = '';
}

/** One panel at a time: the second factor takes the password form's place, and the other way round. */
async function openTotp() {
  passwordOpen.value = false;
  totpError.value = '';
  totpCode.value = totpPassword.value = '';
  copied.value = null;
  if (auth.value?.totpEnabled) {
    totpPanel.value = 'disable';
    return;
  }
  // The secret is asked for on the click; nothing is switched on until the first code proves an authenticator holds it.
  totpPanel.value = 'enroll';
  enrollment.value = null;
  totpBusy.value = true;
  try {
    enrollment.value = await repository.totpEnroll();
  } catch {
    totpError.value = t('settings.saveFailed');
  } finally {
    totpBusy.value = false;
  }
}

function closeTotp() {
  totpPanel.value = null;
  enrollment.value = null;
}

async function verifyTotp() {
  totpBusy.value = true;
  totpError.value = '';
  try {
    await repository.totpVerify(totpCode.value.trim());
  } catch (error) {
    totpError.value = error instanceof Error && error.message === INVALID_CODE ? t('settings.security.wrongCode') : t('settings.saveFailed');
    return;
  } finally {
    totpBusy.value = false;
  }
  totpPanel.value = 'recovery';
  await refreshAuth(true);
}

async function disableTotp() {
  totpBusy.value = true;
  totpError.value = '';
  try {
    await repository.totpDisable(totpPassword.value, totpCode.value.trim());
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    totpError.value =
      reason === WRONG_PASSWORD ? t('settings.security.wrongPassword') : reason === INVALID_CODE ? t('settings.security.wrongCode') : t('settings.saveFailed');
    return;
  } finally {
    totpBusy.value = false;
  }
  closeTotp();
  await refreshAuth(false);
}

/** The row reads the server's answer again; if that answer does not come, it reads what the server just confirmed. */
async function refreshAuth(totpEnabled: boolean) {
  try {
    auth.value = await repository.authMethods();
  } catch {
    if (auth.value) auth.value = { ...auth.value, totpEnabled };
  }
}

async function copyText(text: string, what: 'secret' | 'codes') {
  await navigator.clipboard.writeText(text);
  copied.value = what;
  setTimeout(() => {
    if (copied.value === what) copied.value = null;
  }, COPIED_MS);
}

/**
 * The one control in this modal that does not wait for "Save changes": a password is not part of the draft the
 * Cancel button throws away, and it takes the server's answer — wrong current password, too short — on the spot.
 */
async function submitPassword() {
  if (newPassword.value.length < MIN_PASSWORD_LENGTH) {
    passwordError.value = t('settings.security.tooShort', { min: MIN_PASSWORD_LENGTH });
    return;
  }
  if (newPassword.value !== repeatPassword.value) {
    passwordError.value = t('settings.security.mismatch');
    return;
  }
  passwordBusy.value = true;
  passwordError.value = '';
  try {
    await repository.changePassword(currentPassword.value, newPassword.value);
    passwordOpen.value = false;
    toast.push(t('settings.security.passwordSaved'));
  } catch (error) {
    passwordError.value = error instanceof Error && error.message === WRONG_PASSWORD ? t('settings.security.wrongPassword') : t('settings.saveFailed');
  } finally {
    passwordBusy.value = false;
  }
}

// The profile form IS the account: filled from what the server holds, and empty where the person left it empty.
watch(
  () => files.user,
  (user) => {
    if (!user) return;
    profile.value = { fullName: user.fullName ?? '', displayName: user.name, jobTitle: user.jobTitle ?? '' };
    avatarUrl.value = user.avatarUrl ?? '';
  },
  { immediate: true },
);

/**
 * A chosen picture is re-encoded to at most AVATAR_PX square before it goes anywhere: the account carries it as an
 * inline `data:` URI that rides along with the user row, so a 4 MB camera photo would be paid for on every read.
 */
async function pickPhoto(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = '';
  if (!file) return;
  const source = await createImageBitmap(file);
  const side = Math.min(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  // Centre-cropped to a square, because the avatar is drawn in a circle and a squashed face is worse than a crop.
  canvas
    .getContext('2d')
    ?.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  source.close();
  avatarUrl.value = canvas.toDataURL('image/jpeg', AVATAR_QUALITY);
}

/** Below `md` the tab column is a scrolling ROW (spec §10), so the pair of arrows that walks it changes with it. */
const { isMobile } = useBreakpoint();

/** Arrows move between tabs and open them, as everywhere else; Tab itself reaches only the selected one. */
function step(delta: number) {
  const index = SECTIONS.findIndex((s) => s.id === active.value);
  const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length];
  active.value = next.id;
  tabs.value[next.id]?.focus();
}

/**
 * Two destinations, one button. The display name, the language, the time zone and the picture are the account's and
 * go to the server; everything else is this browser's and stays in local storage. A server that refuses keeps the
 * modal open with the edit intact — closing it would throw the change away and say nothing.
 */
async function save() {
  saving.value = true;
  try {
    files.user = await repository.updateProfile({
      name: profile.value.displayName,
      fullName: profile.value.fullName,
      jobTitle: profile.value.jobTitle,
      locale: language.value,
      timeZone: draft.value.timeZone,
      avatarUrl: avatarUrl.value,
    });
    if (notify.value) await repository.saveNotifyPrefs(notify.value);
  } catch {
    toast.push(t('settings.saveFailed'));
    return;
  } finally {
    saving.value = false;
  }
  store.apply({ ...draft.value });
  // Switching the assistant off closes the panel it controls; leaving it open would be the setting not applying.
  if (!draft.value.assistantEnabled) view.assistantOpen = false;
  if (language.value !== locale.value) setLocale(language.value);
  store.open = false;
}

/** Sections are told apart by a rule and the space around it — no card inside the card. */
const SECTION = 'mt-6 border-t border-border pt-6';
const LABEL = 'block text-11 leading-none text-text-3';
const SECURITY_ROW = '-mx-2 flex h-10 w-full items-center gap-3 rounded-md px-2 text-left';
</script>

<template>
  <Dialog open :initial-focus="panelEl" class="relative z-40" @close="store.open = false">
    <div class="fixed inset-0 bg-overlay" aria-hidden="true" />
    <div class="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 md:items-center md:p-6">
      <DialogPanel
        ref="panel"
        tabindex="-1"
        class="flex h-[680px] max-h-[calc(100dvh-32px)] w-full max-w-[800px] flex-col rounded-2xl bg-bg px-4 py-5 focus:outline-none shadow-modal"
      >
        <div class="flex items-start">
          <Avatar :initial="files.user?.initial ?? ''" :src="avatarUrl" :size="44" class="!text-13" />
          <div class="ml-4 min-w-0 flex-1">
            <DialogTitle class="truncate-safe text-17 font-semibold leading-none">{{ t('settings.title') }}</DialogTitle>
            <p class="mt-1.5 truncate-safe text-11.5 leading-none text-text-3">{{ t('settings.subtitle') }}</p>
          </div>
          <button
            type="button"
            :aria-label="t('modal.close')"
            class="-mr-2 -mt-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-bg-muted"
            @click="store.open = false"
          >
            <X :size="22" />
          </button>
        </div>

        <div class="mt-5 flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:gap-8">
          <div
            role="tablist"
            :aria-orientation="isMobile ? 'horizontal' : 'vertical'"
            :aria-label="t('settings.title')"
            class="scroll-thin flex shrink-0 gap-px overflow-x-auto md:w-[150px] md:flex-col md:overflow-x-visible"
            @keydown.up.prevent="step(-1)"
            @keydown.down.prevent="step(1)"
            @keydown.left.prevent="step(-1)"
            @keydown.right.prevent="step(1)"
          >
            <button
              v-for="item in nav"
              :key="item.id"
              :ref="(el) => (tabs[item.id] = el as HTMLButtonElement)"
              type="button"
              role="tab"
              :id="`settings-tab-${item.id}`"
              :aria-selected="active === item.id"
              :aria-controls="`settings-panel-${item.id}`"
              :tabindex="active === item.id ? 0 : -1"
              class="flex h-10 shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 text-13 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring md:w-full"
              :class="active === item.id ? 'bg-primary-soft font-medium text-primary' : 'text-text-2 hover:bg-hover-row'"
              @click="active = item.id"
            >
              <component :is="item.icon" :size="18" :stroke-width="1.75" class="shrink-0" />
              <span class="truncate-safe">{{ item.label }}</span>
            </button>
          </div>

          <div
            :id="`settings-panel-${active}`"
            role="tabpanel"
            :aria-labelledby="`settings-tab-${active}`"
            tabindex="0"
            class="scroll-thin min-h-0 flex-1 overflow-y-auto focus:outline-none md:pr-6"
          >
            <section v-if="active === 'profile'">
              <h3 class="text-13 font-semibold leading-none">{{ t('settings.nav.profile') }}</h3>
              <p class="mt-1.5 text-11 leading-none text-text-3">{{ t('settings.profile.hint') }}</p>

              <div class="mt-5 flex flex-wrap items-center gap-y-3">
                <Avatar :initial="files.user?.initial ?? ''" :src="avatarUrl" :size="62" class="!text-18 shrink-0" />
                <div class="ml-4 min-w-[160px] flex-1">
                  <p class="flex flex-wrap items-center gap-2">
                    <span class="truncate-safe text-13 font-semibold leading-none">{{ displayName }}</span>
                    <span v-if="files.user" class="flex h-[22px] shrink-0 items-center rounded-full bg-primary-soft px-2 text-10 font-medium leading-none text-primary">
                      {{ t(`settings.roles.${files.user.role}`) }}
                    </span>
                  </p>
                  <p class="mt-2 truncate-safe text-11.5 leading-none text-text-3">{{ files.user?.email }}</p>
                </div>
                <input ref="photoInput" type="file" accept="image/*" class="sr-only" @change="pickPhoto" />
                <!-- Removal is offered only once there is a picture to remove. -->
                <Button v-if="avatarUrl" variant="outline" class="ml-3 shrink-0 !text-danger" @click="avatarUrl = ''">
                  {{ t('settings.profile.removePhoto') }}
                </Button>
                <Button variant="outline" class="ml-3 shrink-0 max-md:ml-0" @click="photoInput?.click()">
                  {{ t('settings.profile.changePhoto') }}
                </Button>
              </div>

              <div class="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
                <label>
                  <span :class="LABEL">{{ t('settings.profile.fullName') }}</span>
                  <Input v-model="profile.fullName" class="mt-2" :label="t('settings.profile.fullName')" />
                </label>
                <label>
                  <span :class="LABEL">{{ t('settings.profile.displayName') }}</span>
                  <Input v-model="profile.displayName" class="mt-2" :label="t('settings.profile.displayName')" />
                </label>
                <div>
                  <span :class="LABEL">{{ t('settings.profile.email') }}</span>
                  <!-- Read-only: the address is the login identity, changed by an admin. -->
                  <p class="mt-2 flex h-10 items-center rounded-md border border-border bg-bg-muted px-3 text-13 leading-none text-text-3">
                    {{ files.user?.email }}
                  </p>
                </div>
                <label>
                  <span :class="LABEL">{{ t('settings.profile.jobTitle') }}</span>
                  <Input v-model="profile.jobTitle" class="mt-2" :label="t('settings.profile.jobTitle')" />
                </label>
              </div>
            </section>

            <section v-else-if="active === 'preferences'">
              <h3 class="text-13 font-semibold leading-none">{{ t('settings.nav.preferences') }}</h3>
              <p class="mt-1.5 text-11 leading-none text-text-3">{{ t('settings.prefs.hint') }}</p>

              <div class="mt-3 flex flex-col gap-1">
                <SettingRow :label="t('settings.prefs.language')">
                  <Select v-model="language" :options="languageOptions" :width="212" :label="t('settings.prefs.language')" />
                </SettingRow>
                <SettingRow :label="t('settings.prefs.timeZone')">
                  <Select v-model="draft.timeZone" :options="zoneOptions" :width="212" :label="t('settings.prefs.timeZone')" />
                </SettingRow>
                <SettingRow :label="t('settings.prefs.theme')">
                  <Segmented v-model="draft.theme" :options="themeOptions" :label="t('settings.prefs.theme')" class="w-full" />
                </SettingRow>
                <SettingRow :label="t('settings.prefs.compact')" :hint="t('settings.prefs.compactHint')">
                  <Toggle v-model="draft.compactList" :label="t('settings.prefs.compact')" />
                </SettingRow>
              </div>

              <!-- The three ceilings, read-only. The sidebar's bar draws only the first; an upload refused for the
                   file count or for the rolling window has nowhere else in the app that states where it stands. -->
              <!-- Upload defaults have no tab of their own: they are preferences, told apart by a rule. -->
              <div :class="SECTION">
                <h3 class="text-13 font-semibold leading-none">{{ t('settings.storage.title') }}</h3>
                <p class="mt-1.5 text-11 leading-none text-text-3">{{ t('settings.storage.hint') }}</p>

                <div class="mt-3 flex flex-col gap-1">
                  <SettingRow :label="t('settings.storage.defaultFolder')">
                    <!-- Not v-model: choosing a folder also fetches what is inside it, one level at a time. -->
                    <Select
                      :model-value="draft.defaultUploadFolder"
                      :options="folderOptions"
                      :icon="Folder"
                      :width="212"
                      :label="t('settings.storage.defaultFolder')"
                      @update:model-value="pickFolder"
                    />
                  </SettingRow>
                  <SettingRow :label="t('settings.storage.autoPreview')" :hint="t('settings.storage.autoPreviewHint')">
                    <Toggle v-model="draft.autoOpenPreview" :label="t('settings.storage.autoPreview')" />
                  </SettingRow>
                  <SettingRow :label="t('settings.storage.conflict')">
                    <Select v-model="draft.conflictBehavior" :options="conflictOptions" :width="212" :label="t('settings.storage.conflict')" />
                  </SettingRow>
                  <template v-if="quota">
                    <SettingRow :label="t('settings.storage.usedBytes')">
                      <p class="text-13 leading-none text-text-2">{{ quotaBytes }}</p>
                    </SettingRow>
                    <SettingRow :label="t('settings.storage.usedFiles')">
                      <p class="text-13 leading-none text-text-2">{{ quotaFiles }}</p>
                    </SettingRow>
                    <SettingRow :label="t('settings.storage.uploadWindow')" :hint="t('settings.storage.uploadWindowHint', { hours: quota.uploadWindowHours })">
                      <p class="text-13 leading-none text-text-2">{{ quotaUpload }}</p>
                    </SettingRow>
                  </template>
                </div>
              </div>
            </section>

            <section v-else-if="active === 'notifications'">
              <h3 class="text-13 font-semibold leading-none">{{ t('settings.nav.notifications') }}</h3>
              <p class="mt-1.5 text-11 leading-none text-text-3">{{ t('settings.notify.hint') }}</p>
              <div v-if="notify" class="mt-3 flex flex-col gap-1">
                <SettingRow
                  v-for="key in (['shared', 'comments', 'uploads'] as const)"
                  :key="key"
                  :label="t(`settings.notify.${key}`)"
                  :hint="t(`settings.notify.${key}Hint`)"
                >
                  <Toggle v-model="notify[key]" :label="t(`settings.notify.${key}`)" />
                </SettingRow>
              </div>
              <!-- An install with notifications switched off has nothing to offer here, and says so. -->
              <p v-else class="mt-3 text-11 leading-none text-text-3">{{ t('settings.notify.unavailable') }}</p>
            </section>

            <section v-else-if="active === 'security'">
              <h3 class="text-13 font-semibold leading-none">{{ t('settings.nav.security') }}</h3>
              <p class="mt-1.5 text-11 leading-none text-text-3">{{ t('settings.security.hint') }}</p>
              <ul class="mt-3 flex flex-col gap-1">
                <li>
                  <!-- Offered only where the realm allows it; an OIDC account's password lives elsewhere, and the
                       row then names that realm instead of a change it could never make. -->
                  <form v-if="passwordOpen" class="rounded-md border border-border p-3" @submit.prevent="submitPassword">
                    <div class="flex flex-col gap-2">
                      <Input v-model="currentPassword" type="password" :label="t('settings.security.currentPassword')" :placeholder="t('settings.security.currentPassword')" />
                      <Input v-model="newPassword" type="password" :label="t('settings.security.newPassword')" :placeholder="t('settings.security.newPassword')" />
                      <Input v-model="repeatPassword" type="password" :label="t('settings.security.repeatPassword')" :placeholder="t('settings.security.repeatPassword')" />
                    </div>
                    <p v-if="passwordError" class="mt-2 text-10 leading-none text-danger" role="alert">{{ passwordError }}</p>
                    <p v-else class="mt-2 text-10 leading-none text-text-3">{{ t('settings.security.otherSessions') }}</p>
                    <div class="mt-3 flex gap-2">
                      <Button type="submit" :disabled="passwordBusy">{{ t('settings.security.submit') }}</Button>
                      <Button variant="outline" type="button" @click="passwordOpen = false">{{ t('settings.cancel') }}</Button>
                    </div>
                  </form>
                  <button v-else-if="auth?.changePassword" type="button" :class="[SECURITY_ROW, 'hover:bg-hover-row']" @click="openPassword">
                    <KeyRound :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ t('settings.security.password') }}</span>
                    <span class="truncate-safe text-11 leading-none text-text-3">{{ passwordStatus }}</span>
                    <ChevronRight :size="16" class="shrink-0 text-text-3" />
                  </button>
                  <div v-else :class="[SECURITY_ROW, 'cursor-default']">
                    <KeyRound :size="18" :stroke-width="1.75" class="shrink-0 text-text-3" />
                    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none text-text-3">{{ t('settings.security.password') }}</span>
                    <span class="truncate-safe text-11 leading-none text-text-3">{{ passwordStatus }}</span>
                  </div>
                </li>
                <li>
                  <!-- filex's own second step on a local realm, opening in place like the password form. Anywhere
                       else it belongs to the auth provider, and the row only says so. -->
                  <div v-if="totpPanel" class="rounded-md border border-border p-3">
                    <div v-if="totpPanel === 'enroll'">
                      <p class="text-11.5 font-medium leading-none">{{ t('settings.security.twoFactorTurnOn') }}</p>
                      <div v-if="enrollment" class="mt-3 flex gap-4">
                        <!-- White behind the QR on purpose: a dark code on the dark theme's surface does not scan.
                             The SVG is the server's own drawing of the otpauth URL, from the origin the app trusts. -->
                        <!-- eslint-disable-next-line vue/no-v-html -->
                        <div class="h-40 w-40 shrink-0 rounded-md bg-white p-2 [&>svg]:h-full [&>svg]:w-full" v-html="enrollment.qrSvg" />
                        <div class="min-w-0 flex-1">
                          <p class="text-11 leading-[18px] text-text-2">{{ t('settings.security.twoFactorScan') }}</p>
                          <p class="mt-3 text-10 leading-none text-text-3">{{ t('settings.security.twoFactorKey') }}</p>
                          <div class="mt-1.5 flex items-center gap-2">
                            <code class="min-w-0 flex-1 truncate-safe rounded-md bg-bg-muted px-2 py-2 font-mono text-11 leading-none">{{ enrollment.secret }}</code>
                            <Button variant="outline" class="!h-8 shrink-0 px-2.5 !text-11" @click="copyText(enrollment.secret, 'secret')">
                              {{ t(copied === 'secret' ? 'settings.security.copied' : 'settings.security.copy') }}
                            </Button>
                          </div>
                        </div>
                      </div>
                      <form class="mt-3 flex items-start gap-2" @submit.prevent="verifyTotp">
                        <Input
                          v-model="totpCode"
                          class="flex-1"
                          inputmode="numeric"
                          autocomplete="one-time-code"
                          :label="t('settings.security.twoFactorCode')"
                          :placeholder="t('settings.security.twoFactorCode')"
                        />
                        <Button type="submit" :disabled="totpBusy || !enrollment || !totpCode.trim()">{{ t('settings.security.verify') }}</Button>
                        <Button variant="outline" type="button" @click="closeTotp">{{ t('settings.cancel') }}</Button>
                      </form>
                      <p v-if="totpError" class="mt-2 text-10 leading-none text-danger" role="alert">{{ totpError }}</p>
                    </div>
                    <div v-else-if="totpPanel === 'recovery'">
                      <p class="text-11.5 font-medium leading-none">{{ t('settings.security.recoveryCodes') }}</p>
                      <p class="mt-1.5 text-10 leading-[18px] text-text-3">{{ t('settings.security.recoveryCodesHint') }}</p>
                      <ul :aria-label="t('settings.security.recoveryCodes')" class="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 font-mono text-11 leading-none md:grid-cols-2">
                        <li v-for="code in enrollment?.recoveryCodes ?? []" :key="code" class="select-all">{{ code }}</li>
                      </ul>
                      <div class="mt-3 flex gap-2">
                        <Button @click="closeTotp">{{ t('settings.security.done') }}</Button>
                        <Button variant="outline" @click="copyText((enrollment?.recoveryCodes ?? []).join('\n'), 'codes')">
                          {{ t(copied === 'codes' ? 'settings.security.copied' : 'settings.security.copyAll') }}
                        </Button>
                      </div>
                    </div>
                    <form v-else @submit.prevent="disableTotp">
                      <div class="flex flex-col gap-2">
                        <Input
                          v-model="totpPassword"
                          type="password"
                          autocomplete="current-password"
                          :label="t('settings.security.currentPassword')"
                          :placeholder="t('settings.security.currentPassword')"
                        />
                        <Input
                          v-model="totpCode"
                          autocomplete="one-time-code"
                          :label="t('settings.security.twoFactorAnyCode')"
                          :placeholder="t('settings.security.twoFactorAnyCode')"
                        />
                      </div>
                      <p v-if="totpError" class="mt-2 text-10 leading-none text-danger" role="alert">{{ totpError }}</p>
                      <div class="mt-3 flex gap-2">
                        <Button type="submit" class="!bg-danger hover:!bg-danger hover:brightness-95" :disabled="totpBusy || !totpPassword || !totpCode.trim()">
                          {{ t('settings.security.twoFactorTurnOff') }}
                        </Button>
                        <Button variant="outline" type="button" @click="closeTotp">{{ t('settings.cancel') }}</Button>
                      </div>
                    </form>
                  </div>
                  <button v-else-if="auth?.provider === 'local'" type="button" :class="[SECURITY_ROW, 'hover:bg-hover-row']" @click="openTotp">
                    <ShieldCheck :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ t('settings.security.twoFactor') }}</span>
                    <span class="flex items-center gap-1.5 truncate-safe text-11 leading-none text-text-3">
                      <span v-if="secondFactorOn" class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                      {{ secondFactorLabel }}
                    </span>
                    <ChevronRight :size="16" class="shrink-0 text-text-3" />
                  </button>
                  <div v-else :class="[SECURITY_ROW, 'cursor-default']">
                    <ShieldCheck :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ t('settings.security.twoFactor') }}</span>
                    <span class="flex items-center gap-1.5 truncate-safe text-11 leading-none text-text-3">
                      <span v-if="secondFactorOn" class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                      {{ secondFactorLabel }}
                    </span>
                    <ChevronRight :size="16" class="shrink-0 text-text-3" />
                  </div>
                </li>
                <li>
                  <!-- The list opens in place, like the password form: both act at once rather than waiting for
                       "Save changes", and both are about this account rather than about this browser. -->
                  <button
                    v-if="sessions"
                    type="button"
                    :class="[SECURITY_ROW, 'hover:bg-hover-row']"
                    :aria-expanded="sessionsOpen"
                    @click="sessionsOpen = !sessionsOpen"
                  >
                    <Monitor :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ t('settings.security.sessions') }}</span>
                    <span class="truncate-safe text-11 leading-none text-text-3">{{ t('settings.security.sessionsCount', sessions.length) }}</span>
                    <ChevronRight :size="16" class="shrink-0 text-text-3 transition-transform" :class="{ 'rotate-90': sessionsOpen }" />
                  </button>
                  <!-- A server without the endpoint leaves the row standing and silent. -->
                  <div v-else :class="[SECURITY_ROW, 'cursor-default']">
                    <Monitor :size="18" :stroke-width="1.75" class="shrink-0 text-text-3" />
                    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none text-text-3">{{ t('settings.security.sessions') }}</span>
                  </div>

                  <ul
                    v-if="sessions && sessionsOpen"
                    :aria-label="t('settings.security.sessions')"
                    class="mb-1 mt-1 flex flex-col gap-1 pl-[30px]"
                  >
                    <li v-for="session in sessions" :key="session.id" class="flex min-h-9 items-center gap-3">
                      <div class="min-w-0 flex-1">
                        <p class="truncate-safe text-11.5 leading-none">{{ deviceLabel(session.userAgent) || t('settings.security.unknownDevice') }}</p>
                        <p class="mt-1.5 truncate-safe text-10 leading-none text-text-3">
                          {{ [session.ip, t('settings.security.signedIn', { when: formatDate(session.createdAt) })].filter(Boolean).join(' · ') }}
                        </p>
                      </div>
                      <span v-if="session.current" class="shrink-0 text-10 leading-none text-text-3">{{ t('settings.security.currentSession') }}</span>
                      <Button v-else variant="outline" class="!h-8 shrink-0 px-2.5 !text-11" @click="endSession(session.id)">
                        {{ t('settings.security.endSession') }}
                      </Button>
                    </li>
                  </ul>
                  <p v-if="sessionsError" class="mt-1 pl-[30px] text-10 leading-none text-danger" role="alert">{{ sessionsError }}</p>
                </li>
              </ul>
            </section>

            <section v-else>
              <h3 class="text-13 font-semibold leading-none">{{ t('settings.nav.assistant') }}</h3>
              <p class="mt-1.5 text-11 leading-none text-text-3">{{ t('settings.assistant.hint') }}</p>
              <div class="mt-3 flex flex-col gap-1">
                <SettingRow :label="t('settings.assistant.enabled')">
                  <Toggle v-model="draft.assistantEnabled" :label="t('settings.assistant.enabled')" />
                </SettingRow>
                <SettingRow :label="t('settings.assistant.defaultMode')" :hint="t('settings.assistant.defaultModeHint')">
                  <Select v-model="draft.assistantMode" :options="modeOptions" :width="212" :label="t('settings.assistant.defaultMode')" />
                </SettingRow>
              </div>
              <p class="mt-3 text-11 leading-tight text-text-3">{{ t('settings.assistant.providerNote') }}</p>
            </section>
          </div>
        </div>

        <div class="mt-5 flex shrink-0 items-center justify-end gap-3 border-t border-border pt-5">
          <Button variant="outline" class="!h-11 px-5" @click="store.open = false">{{ t('settings.cancel') }}</Button>
          <Button class="!h-11 px-5" :disabled="saving" @click="save">{{ t('settings.save') }}</Button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
