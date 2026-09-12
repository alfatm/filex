<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import { Dialog, DialogPanel } from '@headlessui/vue';
import { useBreakpoint } from '@/composables/useBreakpoint';
import { swallowGhostClick } from '@/lib/ghostClick';

/**
 * The right-hand panel, in the two shapes spec §10 gives it.
 *
 * Desktop: in the flow beside the listing, resized by dragging its left edge. On a phone: whichever shape the
 * caller asks for, over the listing — a 390 px screen has no room to give a panel a column of its own.
 *
 * The decision lives HERE and not in the two callers: how wide a window has to be before a panel may take room
 * away from the page is the panel's own business, and a copy of it in each caller is two places to change.
 *
 * A `resizeLabel` renders the drag handle — desktop only, since the phone shapes have no layout to negotiate with.
 */
const props = withDefaults(
  defineProps<{
    width?: number;
    resizeLabel?: string;
    /** What the panel becomes on a phone: a bottom sheet (the details inspector) or the whole screen (the assistant). */
    mobile?: 'sheet' | 'full';
  }>(),
  { width: 256, resizeLabel: undefined, mobile: 'sheet' },
);
const emit = defineEmits<{ resize: [width: number]; close: [] }>();

// The aria-label and the rest of the caller's attributes belong on whichever element is actually the panel.
defineOptions({ inheritAttrs: false });

const { isDesktop } = useBreakpoint();

/** Spec §10: a column on the desktop, and on a phone whichever shape the caller asked for. */
const shape = computed(() => (isDesktop.value ? 'inline' : props.mobile));

const SHAPES = {
  // A conversation is not an inspector: on a phone it gets the screen.
  full: 'inset-0 w-full',
  // Up from the bottom, the listing behind it — the phone shape for something you read ABOUT what is on screen.
  sheet: 'inset-x-0 bottom-0 max-h-[70dvh] rounded-t-2xl border-t border-border',
} as const;
/**
 * Swipe the sheet away.
 *
 * On the grabber rather than on the whole panel: the panel scrolls, and a drag that starts inside a scrolling
 * region is a scroll — stealing it would make the properties below the fold unreachable. `touch-action: none` on
 * the strip is what keeps the browser from treating this one as a scroll.
 */
const SWIPE_CLOSE_PX = 56;
let swipeFrom: number | null = null;

function swipeStart(event: PointerEvent) {
  if (event.pointerType !== 'touch') return;
  swipeFrom = event.clientY;
}

function swipeMove(event: PointerEvent) {
  if (swipeFrom === null) return;
  if (event.clientY - swipeFrom > SWIPE_CLOSE_PX) {
    swipeFrom = null;
    // The sheet is gone before the finger is lifted; the click it ends with would land on the listing behind it.
    swallowGhostClick();
    emit('close');
  }
}

function swipeEnd() {
  swipeFrom = null;
}

const KEYBOARD_STEP_PX = 16;

let stopDrag: (() => void) | null = null;

function startDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  stopDrag?.();
  const startX = event.clientX;
  const startWidth = props.width;
  const move = (moved: PointerEvent) => emit('resize', startWidth + startX - moved.clientX);
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    stopDrag = null;
  };
  // The pointer leaves the 4px handle at once; the cursor and selection lock follow it until release.
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  stopDrag = stop;
}

function onKeydown(event: KeyboardEvent) {
  const direction = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  emit('resize', props.width + direction * KEYBOARD_STEP_PX);
}

onBeforeUnmount(() => stopDrag?.());
</script>

<template>
  <aside
    v-if="shape === 'inline'"
    v-bind="$attrs"
    class="relative flex h-full shrink-0 flex-col overflow-y-auto border-l border-border bg-bg px-3 py-3"
    :style="{ width: `${width}px` }"
  >
    <div
      v-if="resizeLabel"
      role="separator"
      aria-orientation="vertical"
      :aria-label="resizeLabel"
      :aria-valuenow="width"
      tabindex="0"
      class="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
      @pointerdown="startDrag"
      @keydown="onKeydown"
    />
    <slot />
  </aside>

  <!-- On a phone the panel is modal. headlessui carries the three things an overlay needs and a plain `div` does
       not: Escape, a focus trap, and the focus handed back to whatever opened it. -->
  <Dialog v-else open class="relative z-40" @close="emit('close')">
    <div class="fixed inset-0 bg-overlay" aria-hidden="true" />
    <DialogPanel
      v-bind="$attrs"
      class="fixed flex flex-col overflow-y-auto bg-bg px-3 py-3 shadow-modal"
      :class="SHAPES[shape]"
    >
      <!-- The grabber, and the gesture it promises: a swipe down closes the sheet. Escape, the backdrop and the
           panel's own X do the same for everyone else. -->
      <div
        class="-mt-1 mb-1 flex shrink-0 touch-none justify-center py-2"
        @pointerdown="swipeStart"
        @pointermove="swipeMove"
        @pointerup="swipeEnd"
        @pointercancel="swipeEnd"
      >
        <span class="h-1 w-10 rounded-full bg-border-hover" aria-hidden="true" />
      </div>
      <slot />
    </DialogPanel>
  </Dialog>
</template>
