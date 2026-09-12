<script setup lang="ts">
import { X } from 'lucide-vue-next';

defineProps<{ text: string; actionLabel?: string; closeLabel: string }>();
const emit = defineEmits<{ action: []; close: []; pause: []; resume: [] }>();
</script>

<template>
  <!-- Spec §7: radius 12, shadow-menu. Hover / focus hold the auto-dismiss (the host owns the timer). -->
  <div
    class="flex h-12 min-w-[280px] max-w-[440px] items-center rounded-lg border border-border bg-bg pl-4 pr-1 shadow-menu"
    @mouseenter="emit('pause')"
    @mouseleave="emit('resume')"
    @focusin="emit('pause')"
    @focusout="emit('resume')"
  >
    <span class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ text }}</span>
    <button
      v-if="actionLabel"
      type="button"
      class="ml-3 h-9 shrink-0 rounded-md px-3 text-13 font-medium leading-none text-primary hover:bg-primary-soft"
      @click="emit('action')"
    >
      {{ actionLabel }}
    </button>
    <button type="button" :aria-label="closeLabel" class="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-bg-muted" @click="emit('close')">
      <X :size="18" />
    </button>
  </div>
</template>
