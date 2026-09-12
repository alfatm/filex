<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/ui';
import Modal from '@/ui/Modal.vue';

/**
 * What an expired cookie looks like from inside the app.
 *
 * Without it the shell simply stops working — every listing, every upload and every panel fails at once, with no
 * hint that the reason is a session rather than a broken server. The store checks with the server before raising it and raises it once
 * (see `noteUnauthorized`), so a screen that makes ten failing requests asks about one session, and dismissing
 * it leaves the person on their page.
 */
const { t } = useI18n();
const auth = useAuthStore();
</script>

<template>
  <!-- Above the other dialogs (`z-40`): a preview or the settings modal can be open when the session goes, and
       this is the one message that must not end up underneath one of them. -->
  <Modal v-if="auth.expired" class="!z-50" :title="t('login.expired.title')" :close-label="t('modal.close')" @close="auth.dismissExpired()">
    <p class="text-13 text-text-2">{{ t('login.expired.body') }}</p>
    <template #footer>
      <Button variant="outline" @click="auth.dismissExpired()">{{ t('login.expired.later') }}</Button>
      <Button @click="auth.reauth()">{{ t('login.expired.again') }}</Button>
    </template>
  </Modal>
</template>
