<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { X } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { errorMessage } from '@/lib/errors';
import { useFilesStore } from '@/stores/files';
import { Button, Input } from '@/ui';
import Modal from '@/ui/Modal.vue';

/** Tags of one node. The list is edited locally and written in one call, so Cancel needs no undo. */
const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const files = useFilesStore();

// Read when the modal opens: a listing row carries no tags, so the node the modal was handed knows none — and the
// list is what gets WRITTEN BACK, so opening on a stale empty list and saving would erase what the file had.
const saved = ref<string[]>([]);
const tags = ref<string[]>([]);
const draft = ref('');
const input = ref<InstanceType<typeof Input>>();
const changed = computed(() => tags.value.join(' ') !== saved.value.join(' '));
/**
 * Whether the file's own tags are actually known.
 *
 * Saving writes the whole list, so saving before the read has landed writes a list the file's existing tags are
 * missing from — which ERASES them. A read that failed leaves this false for good: the modal says what went wrong
 * and refuses to save rather than guessing that the file had none.
 */
const loaded = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  let current: string[];
  try {
    current = await repository.listTags(props.node.id);
  } catch (e) {
    error.value = errorMessage(e);
    return;
  }
  saved.value = current;
  loaded.value = true;
  // Merged, not assigned: the box is usable while the read is in flight, and a tag typed in that window is an
  // addition to what the file has. Overwriting here would silently swallow it.
  tags.value = [...saved.value, ...tags.value.filter((tag) => !saved.value.includes(tag))];
});

function add() {
  const value = draft.value.trim();
  draft.value = '';
  if (value && !tags.value.includes(value)) tags.value.push(value);
}

function remove(tag: string) {
  tags.value = tags.value.filter((each) => each !== tag);
}

async function submit() {
  if (!loaded.value) return;
  // A tag left in the box is what the user meant to add, so take it before saving.
  add();
  if (changed.value) await files.setTags(props.node, tags.value);
  emit('close');
}
</script>

<template>
  <Modal :title="t('modal.tags.title')" :close-label="t('modal.close')" :initial-focus="input?.el" @close="emit('close')">
    <p class="text-11.5 leading-tight text-text-3">{{ t('modal.tags.hint') }}</p>
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
      <li v-for="tag in tags" :key="tag" class="flex h-7 items-center gap-1 rounded-full bg-primary-soft pl-3 pr-2 text-11.5 leading-none text-primary">
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
    <p v-else class="mt-3 text-11.5 leading-none text-text-3">{{ t('modal.tags.empty') }}</p>
    <p v-if="error" class="mt-3 text-11 leading-none text-danger" role="alert">{{ error }}</p>

    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!loaded" class="disabled:opacity-50" @click="submit">{{ t('modal.tags.save') }}</Button>
    </template>
  </Modal>
</template>
