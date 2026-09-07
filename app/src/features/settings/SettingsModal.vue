<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { Bell, Camera, ChevronRight, Folder, KeyRound, Monitor, Settings2, ShieldCheck, Sparkles, UserRound, X } from 'lucide-vue-next';
import { repository } from '@/data';
import { MIN_PASSWORD_LENGTH, WRONG_PASSWORD } from '@/data/repository';
import type { AuthMethods, Node } from '@/data/types';
import { useToastStore } from '@/stores/toast';
import { LOCALES, setLocale, type Locale } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import { Avatar, Button, Checkbox, Input, Select } from '@/ui';
import Segmented from './Segmented.vue';
import Toggle from './Toggle.vue';
import { ASSISTANT_MODE_VALUES, CONFLICT_BEHAVIORS, THEMES, TIME_ZONES, useSettingsStore, type Settings } from './settingsStore';

/** Sections are anchors in one scrolling column, so the nav highlights whatever the reader has in view. */
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
const files = useFilesStore();
const store = useSettingsStore();
const toast = useToastStore();

// The modal edits a copy: Cancel just drops it, Save commits everything at once.
const draft = ref<Settings>({ ...store.settings });
const language = ref<Locale>(locale.value as Locale);
const active = ref<SectionId>('profile');
const scroller = ref<HTMLElement>();
const sections = ref<Record<string, HTMLElement>>({});
const folders = ref<Node[]>([]);
// The picture belongs to the ACCOUNT, not to the local settings, so it is drafted on its own.
const avatarUrl = ref('');
const photoInput = ref<HTMLInputElement>();
const saving = ref(false);

/**
 * The Security card asks the server how this account signs in before it offers anything: a password form on an
 * OIDC realm could only ever fail, and the second factor belongs to whatever provider the realm names.
 */
const auth = ref<AuthMethods | null>(null);
const passwordOpen = ref(false);
const passwordBusy = ref(false);
const passwordError = ref('');
const currentPassword = ref('');
const newPassword = ref('');
const repeatPassword = ref('');

const providerLabel = computed(() => {
  const key = `settings.security.provider.${auth.value?.provider ?? ''}`;
  return te(key) ? t(key) : t('settings.security.provider.unknown');
});

/** The second factor in one clause: filex's own TOTP on a local realm, otherwise the provider's business. */
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

const displayName = computed(() => draft.value.displayName || files.user?.name || '');

onMounted(async () => {
  if (files.storage) folders.value = await repository.listFolders(files.storage.id);
  auth.value = await repository.authMethods();
});

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

// Prefill the profile form from the account once, so empty mock fields still show the real name.
watch(
  () => files.user,
  (user) => {
    if (!user) return;
    draft.value.fullName ||= user.name;
    draft.value.displayName ||= user.name;
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

function onScroll() {
  const top = scroller.value?.getBoundingClientRect().top ?? 0;
  // The last section whose heading has passed the top edge wins; anything above the fold keeps the first.
  const passed = SECTIONS.filter((s) => (sections.value[s.id]?.getBoundingClientRect().top ?? Infinity) - top <= 8);
  active.value = passed.at(-1)?.id ?? 'profile';
}

function goTo(id: SectionId) {
  active.value = id;
  sections.value[id]?.scrollIntoView({ block: 'start' });
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
      name: draft.value.displayName,
      locale: language.value,
      timeZone: draft.value.timeZone,
      avatarUrl: avatarUrl.value,
    });
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

const CARD = 'rounded-lg border border-border p-4';
const LABEL = 'block text-13 leading-none text-text-3';
</script>

<template>
  <Dialog open :initial-focus="panelEl" class="relative z-40" @close="store.open = false">
    <div class="fixed inset-0 bg-overlay" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center overflow-y-auto p-6">
      <DialogPanel ref="panel" tabindex="-1" class="flex max-h-[850px] w-[808px] flex-col rounded-2xl bg-bg px-4 py-5 focus:outline-none shadow-modal">
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

        <div class="mt-5 flex min-h-0 flex-1 gap-4">
          <nav class="w-[142px] shrink-0" :aria-label="t('settings.title')">
            <ul class="flex flex-col gap-px">
              <li v-for="item in nav" :key="item.id">
                <button
                  type="button"
                  :aria-current="active === item.id ? 'true' : undefined"
                  class="flex h-10 w-full items-center gap-3 rounded-md px-3 text-15 leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                  :class="active === item.id ? 'bg-primary-soft font-medium text-primary' : 'text-text-2 hover:bg-hover-row'"
                  @click="goTo(item.id)"
                >
                  <component :is="item.icon" :size="18" :stroke-width="1.75" class="shrink-0" />
                  <span class="truncate-safe">{{ item.label }}</span>
                </button>
              </li>
            </ul>
          </nav>

          <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border p-[14px]" @scroll="onScroll">
            <section :ref="(el) => (sections.profile = el as HTMLElement)" :class="CARD" :aria-label="t('settings.nav.profile')">
              <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.profile') }}</h3>
              <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.profile.hint') }}</p>

              <div class="mt-4 flex items-center">
                <span class="relative shrink-0">
                  <Avatar :initial="files.user?.initial ?? ''" :src="avatarUrl" :size="62" class="!text-22" />
                  <span class="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-bg text-text-2">
                    <Camera :size="13" />
                  </span>
                </span>
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
                <Button variant="outline" class="ml-3 shrink-0" @click="photoInput?.click()">
                  {{ t('settings.profile.changePhoto') }}
                </Button>
                <Button variant="outline" class="ml-2 shrink-0 !text-danger" :disabled="!avatarUrl" @click="avatarUrl = ''">
                  {{ t('settings.profile.removePhoto') }}
                </Button>
              </div>

              <div class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                <label>
                  <span :class="LABEL">{{ t('settings.profile.fullName') }}</span>
                  <Input v-model="draft.fullName" class="mt-2" :label="t('settings.profile.fullName')" />
                </label>
                <label>
                  <span :class="LABEL">{{ t('settings.profile.displayName') }}</span>
                  <Input v-model="draft.displayName" class="mt-2" :label="t('settings.profile.displayName')" />
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
                  <Input v-model="draft.jobTitle" class="mt-2" :label="t('settings.profile.jobTitle')" />
                </label>
              </div>
            </section>

            <div class="mt-3 grid grid-cols-[minmax(0,1fr)_244px] items-start gap-[14px]">
              <div class="flex flex-col gap-3">
                <section :ref="(el) => (sections.preferences = el as HTMLElement)" :class="CARD" :aria-label="t('settings.nav.preferences')">
                  <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.preferences') }}</h3>
                  <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.prefs.hint') }}</p>

                  <div class="mt-4 grid grid-cols-2 gap-4">
                    <label>
                      <span :class="LABEL">{{ t('settings.prefs.language') }}</span>
                      <Select v-model="language" class="mt-2" :options="languageOptions" :label="t('settings.prefs.language')" />
                    </label>
                    <label>
                      <span :class="LABEL">{{ t('settings.prefs.timeZone') }}</span>
                      <Select v-model="draft.timeZone" class="mt-2" :options="zoneOptions" :label="t('settings.prefs.timeZone')" />
                    </label>
                  </div>

                  <div class="mt-4 flex items-center">
                    <span class="w-[110px] shrink-0 text-15 leading-none">{{ t('settings.prefs.theme') }}</span>
                    <Segmented v-model="draft.theme" :options="themeOptions" :label="t('settings.prefs.theme')" class="flex-1" />
                  </div>

                  <div class="mt-4 flex items-start gap-2.5">
                    <Checkbox v-model="draft.compactList" :label="t('settings.prefs.compact')" />
                    <div class="-mt-0.5">
                      <p class="text-15 leading-none">{{ t('settings.prefs.compact') }}</p>
                      <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.prefs.compactHint') }}</p>
                    </div>
                  </div>
                </section>

                <section :class="CARD">
                  <h3 class="text-16 font-semibold leading-none">{{ t('settings.storage.title') }}</h3>
                  <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.storage.hint') }}</p>

                  <div class="mt-4 flex items-center">
                    <span class="flex-1 text-15 leading-none">{{ t('settings.storage.defaultFolder') }}</span>
                    <Select
                      v-model="draft.defaultUploadFolder"
                      :options="folderOptions"
                      :icon="Folder"
                      :width="180"
                      :label="t('settings.storage.defaultFolder')"
                    />
                  </div>
                  <div class="mt-3 flex items-center gap-3">
                    <span class="w-[150px] shrink-0 text-15 leading-none">{{ t('settings.storage.autoPreview') }}</span>
                    <Toggle v-model="draft.autoOpenPreview" :label="t('settings.storage.autoPreview')" />
                    <span class="text-13 leading-tight text-text-3">{{ t('settings.storage.autoPreviewHint') }}</span>
                  </div>
                  <div class="mt-3 flex items-center">
                    <span class="flex-1 text-15 leading-none">{{ t('settings.storage.conflict') }}</span>
                    <Select v-model="draft.conflictBehavior" :options="conflictOptions" :width="180" :label="t('settings.storage.conflict')" />
                  </div>
                </section>

                <section :ref="(el) => (sections.notifications = el as HTMLElement)" :class="CARD" :aria-label="t('settings.nav.notifications')">
                  <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.notifications') }}</h3>
                  <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.notify.hint') }}</p>
                  <div class="mt-4 flex flex-col gap-3">
                    <div v-for="key in (['notifyShared', 'notifyComments', 'notifyUploads'] as const)" :key="key" class="flex items-center">
                      <div class="min-w-0 flex-1">
                        <p class="text-15 leading-none">{{ t(`settings.notify.${key}`) }}</p>
                        <p class="mt-1.5 text-13 leading-none text-text-3">{{ t(`settings.notify.${key}Hint`) }}</p>
                      </div>
                      <Toggle v-model="draft[key]" :label="t(`settings.notify.${key}`)" />
                    </div>
                  </div>
                </section>
              </div>

              <div class="flex flex-col gap-3">
                <section :ref="(el) => (sections.security = el as HTMLElement)" :class="CARD" :aria-label="t('settings.nav.security')">
                  <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.security') }}</h3>
                  <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.security.hint') }}</p>
                  <ul class="mt-4 flex flex-col gap-2">
                    <!-- How this account signs in. Read-only on purpose: the realm and its second step are the
                         auth provider's, and this app is not where either is configured. -->
                    <li>
                      <div class="flex h-[52px] w-full items-center rounded-md border border-border px-2.5">
                        <ShieldCheck :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                        <div class="ml-2.5 min-w-0 flex-1">
                          <p class="truncate-safe text-13 font-medium leading-none">{{ t('settings.security.signIn') }}</p>
                          <p class="mt-1.5 truncate-safe text-12 leading-none text-text-3">{{ providerLabel }} · {{ secondFactorLabel }}</p>
                        </div>
                      </div>
                    </li>
                    <li>
                      <!-- Offered only where the realm allows it; an OIDC account's password lives elsewhere. -->
                      <form v-if="passwordOpen" class="rounded-md border border-border p-2.5" @submit.prevent="submitPassword">
                        <div class="flex flex-col gap-2">
                          <Input v-model="currentPassword" type="password" :label="t('settings.security.currentPassword')" :placeholder="t('settings.security.currentPassword')" />
                          <Input v-model="newPassword" type="password" :label="t('settings.security.newPassword')" :placeholder="t('settings.security.newPassword')" />
                          <Input v-model="repeatPassword" type="password" :label="t('settings.security.repeatPassword')" :placeholder="t('settings.security.repeatPassword')" />
                        </div>
                        <p v-if="passwordError" class="mt-2 text-12 leading-none text-danger" role="alert">{{ passwordError }}</p>
                        <p v-else class="mt-2 text-12 leading-none text-text-3">{{ t('settings.security.otherSessions') }}</p>
                        <div class="mt-2.5 flex gap-2">
                          <Button type="submit" :disabled="passwordBusy">{{ t('settings.security.submit') }}</Button>
                          <Button variant="outline" type="button" @click="passwordOpen = false">{{ t('settings.cancel') }}</Button>
                        </div>
                      </form>
                      <button
                        v-else-if="auth?.changePassword"
                        type="button"
                        class="flex h-[52px] w-full items-center rounded-md border border-border px-2.5 text-left hover:bg-hover-row"
                        @click="openPassword"
                      >
                        <KeyRound :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                        <div class="ml-2.5 min-w-0 flex-1">
                          <p class="truncate-safe text-13 font-medium leading-none">{{ t('settings.security.password') }}</p>
                          <p class="mt-1.5 truncate-safe text-12 leading-none text-text-3">{{ t('settings.security.passwordHint') }}</p>
                        </div>
                        <ChevronRight :size="16" class="shrink-0 text-text-3" />
                      </button>
                      <div v-else class="flex h-[52px] w-full cursor-default items-center rounded-md border border-border px-2.5">
                        <KeyRound :size="18" :stroke-width="1.75" class="shrink-0 text-text-3" />
                        <div class="ml-2.5 min-w-0 flex-1">
                          <p class="truncate-safe text-13 font-medium leading-none text-text-3">{{ t('settings.security.password') }}</p>
                          <p class="mt-1.5 truncate-safe text-12 leading-none text-text-3">{{ t('settings.security.passwordProvider') }}</p>
                        </div>
                      </div>
                    </li>
                    <li>
                      <!-- Inert: filex has no session-listing endpoint (BACKEND-GAP.md). -->
                      <div class="flex h-[52px] w-full cursor-default items-center rounded-md border border-border px-2.5" :title="t('common.comingSoon')">
                        <Monitor :size="18" :stroke-width="1.75" class="shrink-0 text-text-2" />
                        <div class="ml-2.5 min-w-0 flex-1">
                          <p class="truncate-safe text-13 font-medium leading-none">{{ t('settings.security.sessions') }}</p>
                          <p class="mt-1.5 truncate-safe text-12 leading-none text-text-3">{{ t('settings.security.sessionsHint') }}</p>
                        </div>
                        <ChevronRight :size="16" class="shrink-0 text-text-3" />
                      </div>
                    </li>
                  </ul>
                  <Button variant="outline" class="mt-4 w-full cursor-default" aria-disabled="true" :title="t('common.comingSoon')">
                    {{ t('settings.security.manage') }}
                  </Button>
                </section>

                <section :ref="(el) => (sections.assistant = el as HTMLElement)" :class="CARD" :aria-label="t('settings.nav.assistant')">
                  <h3 class="text-16 font-semibold leading-none">{{ t('settings.nav.assistant') }}</h3>
                  <p class="mt-1.5 text-13 leading-none text-text-3">{{ t('settings.assistant.hint') }}</p>
                  <div class="mt-4 flex items-center">
                    <span class="min-w-0 flex-1 text-15 leading-none">{{ t('settings.assistant.enabled') }}</span>
                    <Toggle v-model="draft.assistantEnabled" :label="t('settings.assistant.enabled')" />
                  </div>
                  <label class="mt-4 block">
                    <span :class="LABEL">{{ t('settings.assistant.defaultMode') }}</span>
                    <Select v-model="draft.assistantMode" class="mt-2" :options="modeOptions" :label="t('settings.assistant.defaultMode')" />
                  </label>
                  <p class="mt-3 text-13 leading-tight text-text-3">{{ t('settings.assistant.providerNote') }}</p>
                </section>
              </div>
            </div>
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
