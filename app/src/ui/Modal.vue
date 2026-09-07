<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { X } from 'lucide-vue-next';

/**
 * Spec §7 modal frame: w 480, radius 16, padding 26, title 20/600. Footer buttons are h 44 (`size="lg"` is the
 * sidebar's 52). Always open: the host renders one modal at a time and unmounts it to close.
 */
withDefaults(defineProps<{ title: string; closeLabel: string; width?: number; initialFocus?: HTMLElement | null }>(), {
  width: 480,
  initialFocus: null,
});
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Dialog open :initial-focus="initialFocus ?? undefined" class="relative z-40" @close="emit('close')">
    <div class="fixed inset-0" style="background: rgba(17, 24, 39, 0.45)" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center overflow-y-auto">
      <DialogPanel class="rounded-2xl bg-bg p-[26px] shadow-modal" :style="{ width: `${width}px` }">
        <div class="flex items-start">
          <DialogTitle class="min-w-0 flex-1 truncate-safe text-20 font-semibold leading-none">{{ title }}</DialogTitle>
          <button
            type="button"
            :aria-label="closeLabel"
            class="-mr-2 -mt-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-bg-muted"
            @click="emit('close')"
          >
            <X :size="22" />
          </button>
        </div>
        <div class="mt-5">
          <slot />
        </div>
        <div v-if="$slots.footer" class="mt-6 flex items-center justify-end gap-3 [&>button]:!h-11 [&>button]:rounded-md [&>button]:px-5">
          <slot name="footer" />
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
