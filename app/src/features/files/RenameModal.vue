<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Node } from '@/data/types';
import { DUPLICATE_NAME, INVALID_NAME } from '@/data/repository';
import { useFilesStore } from '@/stores/files';
import { isValidEntryName } from './entryName';
import { Button, Input } from '@/ui';
import Modal from '@/ui/Modal.vue';

const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();

const name = ref(props.node.name);
const input = ref<InstanceType<typeof Input>>();
const trimmed = computed(() => name.value.trim());
const error = ref<string | null>(null);
const valid = computed(() => isValidEntryName(trimmed.value) && trimmed.value !== props.node.name);
// Said before the request rather than after it: `a/b` and `..` are refused by the server, and the round trip used
// to come back as "That name is already taken" for `..` — the parent folder, which of course exists.
// Only about the name itself: retyping the name it already has leaves the button inert, which says enough.
const nameProblem = computed(() => (trimmed.value && !isValidEntryName(trimmed.value) ? t('modal.invalidName') : null));

// Files: the extension stays out of the selection so typing replaces only the base name.
onMounted(() => {
  const el = input.value?.el;
  if (!el) return;
  const dot = props.node.kind === 'file' ? props.node.name.lastIndexOf('.') : -1;
  el.setSelectionRange(0, dot > 0 ? dot : props.node.name.length);
});

async function submit() {
  if (!valid.value) return;
  try {
    await files.rename(props.node.id, trimmed.value);
  } catch (e) {
    // A collision has its own sentence. Anything else is shown here too, in the server's words: rethrowing it left
    // the modal open with no explanation, because nothing above this catches.
    error.value = readable(e);
    return;
  }
  emit('close');
}

/** The two refusals this dialog has words of its own for; anything else is the server's own sentence. */
function readable(e: unknown): string {
  if (e instanceof Error && e.message === DUPLICATE_NAME) return t('modal.duplicateName');
  if (e instanceof Error && e.message === INVALID_NAME) return t('modal.invalidName');
  return e instanceof Error ? e.message : String(e);
}
</script>

<template>
  <Modal :title="t('modal.rename.title')" :close-label="t('modal.cancel')" :initial-focus="input?.el" @close="emit('close')">
    <Input ref="input" v-model="name" :height="44" :label="t('modal.rename.title')" @enter="submit" @update:model-value="error = null" />
    <p v-if="error || nameProblem" class="mt-2 text-11 leading-none text-danger" role="alert">{{ error ?? nameProblem }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!valid" class="disabled:opacity-50" @click="submit">{{ t('modal.rename.confirm') }}</Button>
    </template>
  </Modal>
</template>
