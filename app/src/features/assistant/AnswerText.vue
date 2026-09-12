<script setup lang="ts">
/** An assistant answer: Markdown parsed into blocks (answer.ts) and drawn with real elements. */
import { computed } from 'vue';
import { parseAnswer } from './answer';
import AnswerSpans from './AnswerSpans.vue';

const props = defineProps<{ text: string }>();

const blocks = computed(() => parseAnswer(props.text));

/** Per heading level, 1–6. */
const HEADING_CLASS = ['mt-3 text-16 font-semibold', 'mt-3 text-15 font-semibold', 'mt-2 text-14 font-semibold', 'font-semibold', 'font-semibold', 'font-semibold'];
</script>

<template>
  <div class="space-y-2 text-13 leading-[1.45]">
    <template v-for="(block, at) in blocks" :key="at">
      <p v-if="block.kind === 'p'" class="whitespace-pre-wrap"><AnswerSpans :spans="block.spans" /></p>
      <!--
        A real `h1`…`h6`, not a bold paragraph: a heading is the one thing a screen reader navigates a document by,
        and the `.md` preview draws its blocks with this same component. The size steps down with the level; the
        deepest levels stop shrinking rather than becoming smaller than the body text.
      -->
      <component :is="`h${block.level}`" v-else-if="block.kind === 'h'" :class="HEADING_CLASS[block.level - 1]">
        <AnswerSpans :spans="block.spans" />
      </component>
      <ul v-else-if="block.kind === 'ul'" class="list-disc space-y-1 pl-5">
        <li v-for="(item, i) in block.items" :key="i"><AnswerSpans :spans="item" /></li>
      </ul>
      <ol v-else-if="block.kind === 'ol'" :start="block.start" class="list-decimal space-y-1 pl-5">
        <li v-for="(item, i) in block.items" :key="i"><AnswerSpans :spans="item" /></li>
      </ol>
      <pre v-else class="overflow-x-auto rounded-md bg-bg px-3 py-2 font-code text-11">{{ block.text }}</pre>
    </template>
  </div>
</template>
