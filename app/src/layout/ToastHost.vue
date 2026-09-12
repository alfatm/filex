<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useToastStore, type Toast } from '@/stores/toast';
import ToastCard from '@/ui/Toast.vue';

const { t } = useI18n();
const toast = useToastStore();

function runAction(item: Toast) {
  item.action?.run();
  toast.dismiss(item.id);
}
</script>

<template>
  <!--
    Spec §7: toasts bottom-left — of the content column, clear of the sidebar's quota block (sidebar w 280).
    The live region is the always-mounted host, so screen readers announce toasts inserted into it.
  -->
  <div role="status" aria-live="polite" class="fixed bottom-6 left-[304px] z-50 flex flex-col gap-2">
    <ToastCard
      v-for="item in toast.toasts"
      :key="item.id"
      :text="item.text"
      :action-label="item.action?.label"
      :close-label="t('toast.close')"
      @action="runAction(item)"
      @close="toast.dismiss(item.id)"
      @pause="toast.pause(item.id)"
      @resume="toast.resume(item.id)"
    />
  </div>
</template>
