<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { X } from 'lucide-vue-next';

/**
 * Spec §7 modal frame: w 480, radius 14, padding 26, title 17/600. Footer buttons take --control-lg, the same
 * height as the sidebar's New button. Always open: the host renders one modal at a time and unmounts it to close.
 */
withDefaults(defineProps<{ title: string; closeLabel: string; width?: number; initialFocus?: HTMLElement | null }>(), {
  width: 480,
  initialFocus: null,
});
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Dialog open :initial-focus="initialFocus ?? undefined" class="relative z-40" @close="emit('close')">
    <div class="fixed inset-0 bg-overlay" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center overflow-y-auto">
      <DialogPanel class="rounded-2xl bg-bg p-[26px] shadow-modal" :style="{ width: `${width}px` }">
        <div class="flex items-start">
          <DialogTitle class="min-w-0 flex-1 truncate-safe text-17 font-semibold leading-none">{{ title }}</DialogTitle>
          <button
            type="button"
            :aria-label="closeLabel"
            class="-mr-1.5 -mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-bg-muted"
            @click="emit('close')"
          >
            <X :size="18" />
          </button>
        </div>
        <div class="mt-5">
          <slot />
        </div>
        <div v-if="$slots.footer" class="mt-5 flex items-center justify-end gap-2 [&>button]:!h-control-lg [&>button]:rounded-md [&>button]:px-4">
          <slot name="footer" />
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
