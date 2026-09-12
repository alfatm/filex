<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { X } from 'lucide-vue-next';

/**
 * Spec §7 modal frame: w 480, radius 14, padding 26, title 17/600. Footer buttons take --control-lg, the same
 * height as the sidebar's New button. Always open: the host renders one modal at a time and unmounts it to close.
 *
 * `width` is a CAP, not a size (spec §10): on a narrow window the panel takes what there is. The audit found the
 * old fixed width drawn off the side of a 390px screen, and a panel taller than the window drawn with no height at
 * all below the bottom of it — a centred flex item cannot scroll up to reveal its own top, so the title and the
 * buttons were unreachable. Hence: capped height, the BODY scrolls, and the panel sits at the top on a phone.
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
    <div class="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 md:items-center">
      <DialogPanel
        class="flex max-h-[calc(100dvh-32px)] w-full flex-col rounded-2xl bg-bg p-[26px] shadow-modal"
        :style="{ maxWidth: `${width}px` }"
      >
        <div class="flex shrink-0 items-start">
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
        <!-- The body is the modal's one scroller: the 6px rail instead of the platform's, and the box reaches into
             the panel's right padding so the rail is drawn beside the content rather than on top of it. A line still
             ends 26px from the panel edge, the same as on the left, whether or not there is anything to scroll. -->
        <div class="scroll-thin -mr-3 mt-5 min-h-0 flex-1 overflow-y-auto pr-3">
          <slot />
        </div>
        <div v-if="$slots.footer" class="mt-5 flex shrink-0 items-center justify-end gap-2 [&>button]:!h-control-lg [&>button]:rounded-md [&>button]:px-4">
          <slot name="footer" />
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
