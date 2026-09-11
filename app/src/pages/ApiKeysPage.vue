<script setup lang="ts">
/**
 * "API keys" — the self-service token manager.
 *
 * Same rule as ConnectPage: `TokensPanel` is the shared component, and `full` is the shape with scopes, folder
 * confinement and expiry rather than the one-field minter the connection guides embed. Every verb is offered to
 * everyone by design — the server caps what it hands out against the caller's own role and grants, so a screen
 * that guessed at the ceiling could only guess wrong.
 */
import { useI18n } from 'vue-i18n';
import { TokensPanel } from '@brftech/filex-core';
import '@brftech/filex-core/style.css';
import { useCoreConfig } from '@/lib/coreConfig';

const { t } = useI18n();
const config = useCoreConfig();
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-6 pl-4 pr-6 pt-3">
    <h1 class="pl-[11px] text-18 font-semibold leading-none">{{ t('nav.apiKeys') }}</h1>
    <div class="mt-3 pl-2">
      <TokensPanel :config="config" full />
    </div>
  </main>
</template>
