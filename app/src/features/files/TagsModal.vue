<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';
import type { Node } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { Button, Input } from '@/ui';
import Modal from '@/ui/Modal.vue';

/** Tags of one node. The list is edited locally and written in one call, so Cancel needs no undo. */
const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const files = useFilesStore();

const tags = ref<string[]>([...(props.node.tags ?? [])]);
const draft = ref('');
const input = ref<InstanceType<typeof Input>>();
const changed = computed(() => tags.value.join(' ') !== (props.node.tags ?? []).join(' '));

function add() {
  const value = draft.value.trim();
  draft.value = '';
  if (value && !tags.value.includes(value)) tags.value.push(value);
}

function remove(tag: string) {
  tags.value = tags.value.filter((each) => each !== tag);
}

async function submit() {
  // A tag left in the box is what the user meant to add, so take it before saving.
  add();
  if (changed.value) await files.setTags(props.node, tags.value);
  emit('close');
}
</script>

<template>
  <Modal :title="t('modal.tags.title')" :close-label="t('modal.close')" :initial-focus="input?.el" @close="emit('close')">
    <p class="text-14 leading-tight text-text-3">{{ t('modal.tags.hint') }}</p>
    <Input
      ref="input"
      v-model="draft"
      class="mt-4"
      :height="44"
      :placeholder="t('modal.tags.placeholder')"
      :label="t('modal.tags.title')"
      @enter="add"
    />
    <ul v-if="tags.length" class="mt-3 flex flex-wrap gap-2" :aria-label="t('modal.tags.title')">
      <li v-for="tag in tags" :key="tag" class="flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-3 pr-2 text-14 leading-none text-primary">
        <span>{{ tag }}</span>
        <button
          type="button"
          class="flex h-4 w-4 items-center justify-center rounded-full hover:bg-primary-tint"
          :aria-label="t('search.removeTag', { tag })"
          @click="remove(tag)"
        >
          <X :size="14" />
        </button>
      </li>
    </ul>
    <p v-else class="mt-3 text-14 leading-none text-text-3">{{ t('modal.tags.empty') }}</p>

    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button @click="submit">{{ t('modal.tags.save') }}</Button>
    </template>
  </Modal>
</template>
