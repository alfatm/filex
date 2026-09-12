<script setup lang="ts">
import { Check, Minus } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    label: string;
    indeterminate?: boolean;
    /** Render `label` as visible text after the box (a `<label>`, so clicking it toggles and names the control). */
    showLabel?: boolean;
  }>(),
  { indeterminate: false, showLabel: false },
);
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <!--
    Without a visible label the wrapper takes no layout of its own, so the box sits exactly as a bare button would.

    The box is the spec's 20×20 (§4) and the `::before` overlay is what a finger hits: 24×24, the WCAG 2.5.8
    minimum, reached by 2px of overhang on each side rather than by growing the box — the drawn geometry is what
    the reference is measured against, the hit area is not.
  -->
  <component :is="showLabel ? 'label' : 'span'" :class="showLabel ? 'flex h-5 items-center gap-2 text-13 leading-none' : 'contents'">
    <button
      type="button"
      role="checkbox"
      :aria-checked="indeterminate ? 'mixed' : model"
      :aria-label="showLabel ? undefined : label"
      class="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] before:absolute before:-inset-[2px] before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
      :class="model || indeterminate ? 'border-primary bg-primary text-white' : 'border-border-hover bg-bg'"
      @click="model = !model"
    >
      <Minus v-if="indeterminate" :size="14" :stroke-width="3" />
      <Check v-else-if="model" :size="14" :stroke-width="3" />
    </button>
    <template v-if="showLabel">
      <span>{{ label }}</span>
      <slot />
    </template>
  </component>
</template>
