<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { Box, Eye, EyeOff, KeyRound, Lock, Mail } from 'lucide-vue-next';
import { repository } from '@/data';
import { ACCOUNT_DISABLED, INVALID_CREDENTIALS, SIGN_IN_LIMITED, TOTP_REQUIRED } from '@/data/repository';
import { noAuthOptions, type AuthOptions } from '@/data/types';
import { errorMessage } from '@/lib/errors';
import { useAuthStore } from '@/stores/auth';
import { useBrandingStore } from '@/stores/branding';
import { Button, Checkbox } from '@/ui';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const branding = useBrandingStore();

const baseUrl = import.meta.env.BASE_URL;

const identifier = ref('');
const password = ref('');
const totp = ref('');
const remember = ref(true);
const showPassword = ref(false);
const showTotp = ref(false);
const error = ref<string | null>(null);

/**
 * Which realms this installation offers, asked for before anybody is signed in.
 *
 * Its own request rather than the shell's capability store: that one folds in the assistant probe, which needs a
 * session. A server that does not answer leaves `noAuthOptions()` standing — the password form and nothing else,
 * which is the one realm that can always be tried.
 */
const options = ref<AuthOptions>(noAuthOptions());

const localOffered = computed(() => options.value.drivers.length === 0 || options.value.drivers.includes('local'));
const oidcOffered = computed(() => options.value.drivers.includes('oidc'));

/**
 * Where signing in lands. The guard puts the address the visitor was refused into `redirect`, so it resumes what
 * they were doing; anything that is not a path of this app is ignored — the value reaches `router.push`, and an
 * app that will follow "//somewhere.else" out of its own origin is an open redirect with extra steps.
 */
const redirect = computed(() => {
  const asked = route.query.redirect;
  return typeof asked === 'string' && asked.startsWith('/') && !asked.startsWith('//') ? asked : '/';
});

/*
 * SSO-first installs (FILEX_OIDC_AUTO_REDIRECT): the visitor goes straight to the identity provider and the
 * password form hides behind `?local=1` — the break-glass path for an account the provider does not carry.
 */
const wantLocal = computed(() => route.query.local !== undefined);
const autoRedirect = computed(() => options.value.oidcAutoRedirect && oidcOffered.value);
const showLocalForm = computed(() => localOffered.value && (!autoRedirect.value || wantLocal.value));
const leaving = ref(false);

onMounted(async () => {
  try {
    options.value = await repository.authOptions();
  } catch {
    // The password form stands. Nothing here is worth refusing a sign-in over.
  }
  if (route.query.error === 'oidc') error.value = t('login.errOidc');
  if (route.query.maintenance !== undefined) error.value = t('login.errLimited');
  /*
   * Loop guards, and the reason this is not simply `if (autoRedirect)`. Coming back FROM the provider with a
   * failure and being sent straight back to it is an infinite bounce the person cannot read a word of; so is a
   * locked-down tenant. And somebody who asked for the password form asked for it.
   */
  if (autoRedirect.value && !wantLocal.value && route.query.error === undefined && route.query.maintenance === undefined) {
    startOidc();
  }
});

/** filex answers all four refusals with a status the form cannot read alone; the repository names them instead. */
const REFUSALS: Record<string, string> = {
  [INVALID_CREDENTIALS]: 'login.errCredentials',
  [TOTP_REQUIRED]: 'login.errTotp',
  [ACCOUNT_DISABLED]: 'login.errDisabled',
  [SIGN_IN_LIMITED]: 'login.errLimited',
};

async function submit() {
  error.value = null;
  try {
    await auth.signIn({
      identifier: identifier.value.trim(),
      password: password.value,
      totp: totp.value.trim() || undefined,
      remember: remember.value,
    });
  } catch (failure) {
    const reason = errorMessage(failure);
    // The code field opens itself on the first refusal that asks for one: the account has a second factor and
    // there is no other way for the person to supply it.
    if (reason === TOTP_REQUIRED) showTotp.value = true;
    error.value = t(REFUSALS[reason] ?? 'login.errUnreachable');
    return;
  }
  await router.push(redirect.value);
}

/**
 * Off to the identity provider. A whole-page navigation, not a route: the next few pages are the provider's, and
 * filex brings the browser back to `return_to` once the callback has minted a session.
 */
function startOidc() {
  const url = repository.oidcStartUrl(baseUrl.replace(/\/$/, '') + redirect.value);
  if (!url) return;
  leaving.value = true;
  window.location.assign(url);
}
</script>

<template>
  <div class="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg-sidebar px-4 py-10">
    <!-- The two washes of the reference: decoration only, and behind everything, so nothing here can be clicked. -->
    <div aria-hidden="true" class="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rotate-12 rounded-[64px] bg-primary-tint" />
    <div aria-hidden="true" class="pointer-events-none absolute -bottom-32 -right-24 h-96 w-96 rotate-12 rounded-[80px] bg-primary-tint" />

    <div class="relative w-full max-w-[672px]">
      <div class="rounded-[20px] bg-bg px-8 py-12 shadow-modal sm:px-[88px]">
        <div class="flex items-center justify-center gap-4">
          <img :src="branding.logoUrl || `${baseUrl}logo.svg`" alt="" class="h-16 w-16 object-contain" />
          <span class="text-[44px] font-bold leading-none tracking-tight">{{ branding.name || t('app.name') }}</span>
        </div>

        <h1 class="mt-8 text-center text-[32px] font-bold leading-none tracking-tight">{{ t('login.title') }}</h1>
        <p class="mt-3 text-center text-16 text-text-2">{{ t('login.subtitle', { app: branding.name || t('app.name') }) }}</p>

        <p v-if="leaving" class="mt-8 text-center text-15 text-text-2">{{ t('login.redirecting') }}</p>

        <!-- A real element and not a <template>: the hand-off flips this whole block away mid-render, and Vue's
             fragment removal needs an anchor that survives it. -->
        <div v-else>
          <p v-if="error" role="alert" class="mt-8 rounded-md border border-danger bg-bg-muted px-4 py-3 text-15 text-danger">{{ error }}</p>

          <!-- SSO leads whenever the installation has a provider: it is the path most of those accounts must take. -->
          <Button v-if="oidcOffered" size="lg" class="mt-8 w-full" @click="startOidc">
            <KeyRound :size="18" />
            {{ t('login.oidc') }}
          </Button>

          <div v-if="oidcOffered && showLocalForm" class="my-6 flex items-center gap-3">
            <span class="h-px flex-1 bg-border" />
            <span class="text-13 uppercase tracking-wide text-text-3">{{ t('login.or') }}</span>
            <span class="h-px flex-1 bg-border" />
          </div>

          <form v-if="showLocalForm" class="mt-8" @submit.prevent="submit">
            <label class="block text-14 font-semibold text-text-2" for="login-identifier">{{ t('login.identifier') }}</label>
            <label for="login-identifier" class="mt-2 flex h-[60px] cursor-text items-center rounded-lg border border-border bg-bg-muted px-5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
              <Mail :size="20" class="shrink-0 text-text-3" />
              <input
                id="login-identifier"
                v-model="identifier"
                type="text"
                autocomplete="username"
                required
                class="ml-4 min-w-0 flex-1 bg-transparent text-16 text-text placeholder:text-text-3 focus:outline-none"
              />
            </label>

            <label class="mt-6 block text-14 font-semibold text-text-2" for="login-password">{{ t('login.password') }}</label>
            <div class="mt-2 flex h-[60px] items-center rounded-lg border border-border bg-bg-muted px-5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
              <!-- The row is the target, not the text: everything but the eye is inside the label. It stops there
                   because a <button> inside a <label> is a labelable element that is not the label's control. -->
              <label for="login-password" class="flex h-full min-w-0 flex-1 cursor-text items-center">
                <Lock :size="20" class="shrink-0 text-text-3" />
                <input
                  id="login-password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  required
                  class="mx-4 min-w-0 flex-1 bg-transparent text-16 text-text placeholder:text-text-3 focus:outline-none"
                />
              </label>
              <button
                type="button"
                class="shrink-0 rounded-sm text-text-3 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                :aria-label="showPassword ? t('login.hidePassword') : t('login.showPassword')"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <component :is="showPassword ? EyeOff : Eye" :size="20" />
              </button>
            </div>

            <!-- Asked for, never assumed: most accounts have no second factor, and a code field on every sign-in
                 is a field most people learn to skip past. -->
            <div class="mt-3 text-right">
              <button
                type="button"
                class="rounded-sm text-15 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
                @click="showTotp = !showTotp"
              >
                {{ showTotp ? t('login.hideTotp') : t('login.useTotp') }}
              </button>
            </div>

            <template v-if="showTotp">
              <label class="mt-3 block text-14 font-semibold text-text-2" for="login-totp">{{ t('login.totp') }}</label>
              <label for="login-totp" class="mt-2 flex h-[60px] cursor-text items-center rounded-lg border border-border bg-bg-muted px-5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
                <input
                  id="login-totp"
                  v-model="totp"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="123456"
                  class="min-w-0 flex-1 bg-transparent text-16 text-text placeholder:text-text-3 focus:outline-none"
                />
              </label>
            </template>

            <Checkbox v-model="remember" show-label :label="t('login.remember')" class="mt-6 !text-16" />

            <Button type="submit" size="lg" class="mt-6 h-[60px] w-full text-16" :disabled="auth.pending">
              <Lock :size="18" />
              {{ t('login.submit') }}
            </Button>
          </form>

          <!-- The way back to the password form on an SSO-first install. -->
          <div v-if="localOffered && autoRedirect && !wantLocal" class="mt-6 text-center">
            <RouterLink
              :to="{ name: 'login', query: { ...route.query, local: '1' } }"
              class="text-14 text-text-3 underline-offset-2 hover:text-text hover:underline"
            >
              {{ t('login.local') }}
            </RouterLink>
          </div>

          <p v-if="!localOffered && !oidcOffered" class="mt-8 text-center text-15 text-danger">{{ t('login.errNoRealm') }}</p>
        </div>
      </div>

      <p v-if="options.version" class="mt-6 flex items-center justify-center gap-2 text-14 text-text-3">
        <Box :size="16" />
        {{ t('app.name') }} v{{ options.version }}
      </p>
    </div>
  </div>
</template>
