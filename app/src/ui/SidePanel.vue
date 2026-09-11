<script setup lang="ts">
import { onBeforeUnmount } from 'vue';

/** A `resizeLabel` renders a drag handle on the panel's outer edge; the panel is always on the right, so dragging left widens it. */
const props = withDefaults(defineProps<{ width?: number; resizeLabel?: string }>(), { width: 256, resizeLabel: undefined });
const emit = defineEmits<{ resize: [width: number] }>();

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
</template>
