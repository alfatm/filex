<script setup lang="ts">
import { Switch } from '@headlessui/vue';

defineProps<{ label: string }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <!-- Same geometry as the share modal's switch: 44×24 track, 20px knob. -->
  <Switch
    v-model="model"
    :aria-label="label"
    class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
    :class="model ? 'bg-primary' : 'bg-border-hover'"
  >
    <span class="inline-block h-5 w-5 rounded-full bg-white shadow-menu transition" :class="model ? 'translate-x-[22px]' : 'translate-x-0.5'" />
  </Switch>
</template>
