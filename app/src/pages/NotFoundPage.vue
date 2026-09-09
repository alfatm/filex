<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { FolderOpen } from 'lucide-vue-next';
import { Button } from '@/ui';
import EmptyState from './files/EmptyState.vue';

/**
 * Any address this app does not have a screen for.
 *
 * Without it an unknown URL matched nothing, and the shell drew itself around an empty content column: no message,
 * no way back, and nothing to say whether the app was broken or the link was. It says the address is the thing
 * that is missing — not a folder: what did not resolve here is the route, and a stale link is the usual reason.
 */
const { t } = useI18n();
const router = useRouter();
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-3 pt-[18px]">
    <EmptyState class="mt-24" :icon="FolderOpen" :title="t('error.noSuchPage.title')" :hint="t('error.noSuchPage.hint')">
      <Button variant="outline" @click="router.push({ name: 'home' })">{{ t('nav.home') }}</Button>
    </EmptyState>
  </main>
</template>
