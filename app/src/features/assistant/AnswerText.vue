<script setup lang="ts">
/** An assistant answer: Markdown parsed into blocks (answer.ts) and drawn with real elements. */
import { computed } from 'vue';
import { parseAnswer } from './answer';
import AnswerSpans from './AnswerSpans.vue';

const props = defineProps<{ text: string }>();

const blocks = computed(() => parseAnswer(props.text));
</script>

<template>
  <div class="space-y-2 text-15 leading-[1.45]">
    <template v-for="(block, at) in blocks" :key="at">
      <p v-if="block.kind === 'p'" class="whitespace-pre-wrap"><AnswerSpans :spans="block.spans" /></p>
      <p v-else-if="block.kind === 'h'" class="font-semibold"><AnswerSpans :spans="block.spans" /></p>
      <ul v-else-if="block.kind === 'ul'" class="list-disc space-y-1 pl-5">
        <li v-for="(item, i) in block.items" :key="i"><AnswerSpans :spans="item" /></li>
      </ul>
      <ol v-else-if="block.kind === 'ol'" :start="block.start" class="list-decimal space-y-1 pl-5">
        <li v-for="(item, i) in block.items" :key="i"><AnswerSpans :spans="item" /></li>
      </ol>
      <pre v-else class="overflow-x-auto rounded-md bg-bg px-3 py-2 font-code text-13">{{ block.text }}</pre>
    </template>
  </div>
</template>
