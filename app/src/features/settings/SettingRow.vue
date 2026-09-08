<script setup lang="ts">
defineProps<{ label: string; hint?: string }>();
</script>

<template>
  <!-- One setting per line: what it is on the left, the control that changes it in a fixed column on the right.
       A row that explains itself is taller, so its two lines read as one block rather than as two rows. -->
  <div class="flex items-center gap-6" :class="hint ? 'min-h-[52px]' : 'min-h-9'">
    <div class="min-w-0 flex-1">
      <p class="text-15 leading-none">{{ label }}</p>
      <p v-if="hint" class="mt-1.5 text-13 leading-none text-text-3">{{ hint }}</p>
    </div>
    <div class="flex w-[212px] shrink-0 justify-end"><slot /></div>
  </div>
</template>
