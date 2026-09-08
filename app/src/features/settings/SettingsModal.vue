<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { Bell, ChevronRight, Folder, KeyRound, Monitor, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-vue-next';
import { repository } from '@/data';
import { MIN_PASSWORD_LENGTH, WRONG_PASSWORD } from '@/data/repository';
import type { AuthMethods, Node, NotifyPrefs, Session } from '@/data/types';
import { useToastStore } from '@/stores/toast';
import { LOCALES, setLocale, type Locale } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { Avatar, Button, Input, Select } from '@/ui';
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

const { t, te, locale } = useI18n();
const { formatDate } = useFormat();
const files = useFilesStore();
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
const folders = ref<Node[]>([]);
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

const folderOptions = computed(() => [
  { value: '', label: t('nav.files') },
  ...folders.value.filter((f) => f.parentId).map((f) => ({ value: f.id, label: f.name })),
]);

const displayName = computed(() => profile.value.displayName || files.user?.name || '');

onMounted(async () => {
  if (files.storage) folders.value = await repository.listFolders(files.storage.id);
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
  passwordOpen.value = true;
  passwordError.value = '';
  currentPassword.value = newPassword.value = repeatPassword.value = '';
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
  if (language.value !== locale.value) setLocale(language.value);
  store.open = false;
}

/** Sections are told apart by a rule and the space around it — no card inside the card. */
const SECTION = 'mt-6 border-t border-border pt-6';
const LABEL = 'block text-13 leading-none text-text-3';
const SECURITY_ROW = '-mx-2 flex h-10 w-full items-center gap-3 rounded-md px-2 text-left';
</script>

<template>
  <Dialog open :initial-focus="panelEl" class="relative z-40" @close="store.open = false">
    <div class="fixed inset-0 bg-overlay" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center overflow-y-auto p-6">
      <DialogPanel
        ref="panel"
        tabindex="-1"
        class="flex h-[680px] max-h-[calc(100vh-48px)] w-[800px] flex-col rounded-2xl bg-bg px-4 py-5 focus:outline-none shadow-modal"
      >
        <div class="flex items-start">
          <Avatar :initial="files.user?.initial ?? ''" :src="avatarUrl" :size="44" class="!text-16" />
          <div class="ml-4 min-w-0 flex-1">
            <DialogTitle class="truncate-safe text-20 font-semibold leading-none">{{ t('settings.title') }}</DialogTitle>
            <p class="mt-1.5 truncate-safe text-14 leading-none text-text-3">{{ t('settings.subtitle') }}</p>
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

        <div class="mt-5 flex min-h-0 flex-1 gap-8">
          <div
            role="tablist"
            aria-orientation="vertical"
            :aria-label="t('settings.title')"
            class="flex w-[150px] shrink-0 flex-col gap-px"
            @keydown.up.prevent="step(-1)"
            @keydown.down.prevent="step(1)"
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
              class="flex h-10 w-full items-center gap-3 rounded-md px-3 text-15 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
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
            class="scroll-thin min-h-0 flex-1 overflow-y-auto pr-6 focus:outline-none"
          >
            <section v-if="active === 'profile'">
              <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.profile') }}</h3>
              <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.profile.hint') }}</p>

              <div class="mt-5 flex items-center">
                <Avatar :initial="files.user?.initial ?? ''" :src="avatarUrl" :size="62" class="!text-22 shrink-0" />
                <div class="ml-4 min-w-0 flex-1">
                  <p class="flex items-center gap-2">
                    <span class="truncate-safe text-17 font-semibold leading-none">{{ displayName }}</span>
                    <span v-if="files.user" class="flex h-[22px] shrink-0 items-center rounded-full bg-primary-soft px-2 text-12 font-medium leading-none text-primary">
                      {{ t(`settings.roles.${files.user.role}`) }}
                    </span>
                  </p>
                  <p class="mt-2 truncate-safe text-14 leading-none text-text-3">{{ files.user?.email }}</p>
                </div>
                <input ref="photoInput" type="file" accept="image/*" class="sr-only" @change="pickPhoto" />
                <!-- Removal is offered only once there is a picture to remove. -->
                <Button v-if="avatarUrl" variant="outline" class="ml-3 shrink-0 !text-danger" @click="avatarUrl = ''">
                  {{ t('settings.profile.removePhoto') }}
                </Button>
                <Button variant="outline" class="ml-3 shrink-0" @click="photoInput?.click()">
                  {{ t('settings.profile.changePhoto') }}
                </Button>
              </div>

              <div class="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
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
                  <p class="mt-2 flex h-10 items-center rounded-md border border-border bg-bg-muted px-3 text-15 leading-none text-text-3">
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
              <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.preferences') }}</h3>
              <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.prefs.hint') }}</p>

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

              <!-- Upload defaults have no tab of their own: they are preferences, told apart by a rule. -->
              <div :class="SECTION">
                <h3 class="text-16 font-semibold leading-none">{{ t('settings.storage.title') }}</h3>
                <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.storage.hint') }}</p>

                <div class="mt-3 flex flex-col gap-1">
                  <SettingRow :label="t('settings.storage.defaultFolder')">
                    <Select
                      v-model="draft.defaultUploadFolder"
                      :options="folderOptions"
                      :icon="Folder"
                      :width="212"
                      :label="t('settings.storage.defaultFolder')"
                    />
                  </SettingRow>
                  <SettingRow :label="t('settings.storage.autoPreview')" :hint="t('settings.storage.autoPreviewHint')">
                    <Toggle v-model="draft.autoOpenPreview" :label="t('settings.storage.autoPreview')" />
                  </SettingRow>
                  <SettingRow :label="t('settings.storage.conflict')">
                    <Select v-model="draft.conflictBehavior" :options="conflictOptions" :width="212" :label="t('settings.storage.conflict')" />
                  </SettingRow>
                </div>
              </div>
            </section>

            <section v-else-if="active === 'notifications'">
              <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.notifications') }}</h3>
              <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.notify.hint') }}</p>
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
              <p v-else class="mt-3 text-13 leading-none text-text-3">{{ t('settings.notify.unavailable') }}</p>
            </section>

            <section v-else-if="active === 'security'">
              <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.security') }}</h3>
              <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.security.hint') }}</p>
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
                    <p v-if="passwordError" class="mt-2 text-12 leading-none text-danger" role="alert">{{ passwordError }}</p>
                    <p v-else class="mt-2 text-12 leading-none text-text-3">{{ t('settings.security.otherSessions') }}</p>
                    <div class="mt-3 flex gap-2">
                      <Button type="submit" :disabled="passwordBusy">{{ t('settings.security.submit') }}</Button>
                      <Button variant="outline" type="button" @click="passwordOpen = false">{{ t('settings.cancel') }}</Button>
                    </div>
                  </form>
                  <button v-else-if="auth?.changePassword" type="button" :class="[SECURITY_ROW, 'hover:bg-hover-row']" @click="openPassword">
                    <KeyRound :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                    <span class="min-w-0 flex-1 truncate-safe text-15 leading-none">{{ t('settings.security.password') }}</span>
                    <span class="truncate-safe text-13 leading-none text-text-3">{{ passwordStatus }}</span>
                    <ChevronRight :size="16" class="shrink-0 text-text-3" />
                  </button>
                  <div v-else :class="[SECURITY_ROW, 'cursor-default']">
                    <KeyRound :size="18" :stroke-width="1.75" class="shrink-0 text-text-3" />
                    <span class="min-w-0 flex-1 truncate-safe text-15 leading-none text-text-3">{{ t('settings.security.password') }}</span>
                    <span class="truncate-safe text-13 leading-none text-text-3">{{ passwordStatus }}</span>
                  </div>
                </li>
                <li>
                  <!-- Read-only: the second step belongs to the auth provider, and `GET /api/auth/methods` is what
                       this row asks. -->
                  <div :class="[SECURITY_ROW, 'cursor-default']" :title="t('common.comingSoon')">
                    <ShieldCheck :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                    <span class="min-w-0 flex-1 truncate-safe text-15 leading-none">{{ t('settings.security.twoFactor') }}</span>
                    <span class="flex items-center gap-1.5 truncate-safe text-13 leading-none text-text-3">
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
                    <span class="min-w-0 flex-1 truncate-safe text-15 leading-none">{{ t('settings.security.sessions') }}</span>
                    <span class="truncate-safe text-13 leading-none text-text-3">{{ t('settings.security.sessionsCount', sessions.length) }}</span>
                    <ChevronRight :size="16" class="shrink-0 text-text-3 transition-transform" :class="{ 'rotate-90': sessionsOpen }" />
                  </button>
                  <!-- A server without the endpoint leaves the row standing and silent. -->
                  <div v-else :class="[SECURITY_ROW, 'cursor-default']">
                    <Monitor :size="18" :stroke-width="1.75" class="shrink-0 text-text-3" />
                    <span class="min-w-0 flex-1 truncate-safe text-15 leading-none text-text-3">{{ t('settings.security.sessions') }}</span>
                  </div>

                  <ul
                    v-if="sessions && sessionsOpen"
                    :aria-label="t('settings.security.sessions')"
                    class="mb-1 mt-1 flex flex-col gap-1 pl-[30px]"
                  >
                    <li v-for="session in sessions" :key="session.id" class="flex min-h-9 items-center gap-3">
                      <div class="min-w-0 flex-1">
                        <p class="truncate-safe text-14 leading-none">{{ deviceLabel(session.userAgent) || t('settings.security.unknownDevice') }}</p>
                        <p class="mt-1.5 truncate-safe text-12 leading-none text-text-3">
                          {{ [session.ip, t('settings.security.signedIn', { when: formatDate(session.createdAt) })].filter(Boolean).join(' · ') }}
                        </p>
                      </div>
                      <span v-if="session.current" class="shrink-0 text-12 leading-none text-text-3">{{ t('settings.security.currentSession') }}</span>
                      <Button v-else variant="outline" class="!h-8 shrink-0 px-2.5 !text-13" @click="endSession(session.id)">
                        {{ t('settings.security.endSession') }}
                      </Button>
                    </li>
                  </ul>
                  <p v-if="sessionsError" class="mt-1 pl-[30px] text-12 leading-none text-danger" role="alert">{{ sessionsError }}</p>
                </li>
              </ul>
            </section>

            <section v-else>
              <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.assistant') }}</h3>
              <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.assistant.hint') }}</p>
              <div class="mt-3 flex flex-col gap-1">
                <SettingRow :label="t('settings.assistant.enabled')">
                  <Toggle v-model="draft.assistantEnabled" :label="t('settings.assistant.enabled')" />
                </SettingRow>
                <SettingRow :label="t('settings.assistant.defaultMode')">
                  <Select v-model="draft.assistantMode" :options="modeOptions" :width="212" :label="t('settings.assistant.defaultMode')" />
                </SettingRow>
              </div>
              <p class="mt-3 text-13 leading-tight text-text-3">{{ t('settings.assistant.providerNote') }}</p>
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
