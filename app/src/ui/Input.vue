<script setup lang="ts">
import { ref, useId, type Component } from 'vue';

withDefaults(
  defineProps<{
    placeholder?: string;
    icon?: Component;
    height?: number;
    width?: number;
    type?: 'text' | 'search' | 'number' | 'password' | 'date';
    label?: string;
    autocomplete?: string;
    inputmode?: 'text' | 'numeric';
    /**
     * Values to complete against, offered by the browser's own datalist. The list rides WITH the input rather
     * than being wired up by id at every call site, because an id that has to be matched in two places is an id
     * that eventually is not.
     */
    suggestions?: string[];
  }>(),
  { placeholder: '', icon: undefined, height: 34, width: undefined, type: 'text', label: undefined, autocomplete: undefined, inputmode: undefined, suggestions: undefined },
);

const listId = useId();
// `type="number"` inputs hand v-model a number (Vue casts), every other type a string.
const model = defineModel<string | number>({ required: true });
const emit = defineEmits<{ enter: []; blur: [] }>();
const input = ref<HTMLInputElement>();
defineExpose({
  focus: () => input.value?.focus(),
  /** Highlights `start..end` of the text, the way a name is offered with its extension left alone. */
  select: (start: number, end: number) => input.value?.setSelectionRange(start, end),
  el: input,
});
</script>

<template>
  <label
    class="flex items-center rounded-md border border-border bg-bg px-3 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
    :style="{ height: `${height}px`, width: width ? `${width}px` : undefined }"
  >
    <component :is="icon" v-if="icon" :size="16" class="mr-2 shrink-0 text-text-3" />
    <input
      ref="input"
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :inputmode="inputmode"
      :aria-label="label"
      :list="suggestions?.length ? listId : undefined"
      class="min-w-0 flex-1 bg-transparent text-13 leading-none text-text placeholder:text-text-3 focus:outline-none"
      @blur="emit('blur')"
      @keydown.enter.prevent="emit('enter')"
    />
    <datalist v-if="suggestions?.length" :id="listId">
      <option v-for="suggestion in suggestions" :key="suggestion" :value="suggestion" />
    </datalist>
  </label>
</template>
