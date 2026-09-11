<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { DUPLICATE_NAME, INVALID_NAME } from '@/data/repository';
import { useFilesStore } from '@/stores/files';
import { isValidEntryName } from './entryName';
import { Button, Input } from '@/ui';
import Modal from '@/ui/Modal.vue';

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();

const name = ref(t('modal.newFolder.defaultName'));
const input = ref<InstanceType<typeof Input>>();
const trimmed = computed(() => name.value.trim());
const error = ref<string | null>(null);
const valid = computed(() => isValidEntryName(trimmed.value));
// Said before the request rather than after it: `a/b` and `..` are refused by the server, and the round trip used
// to come back as "That name is already taken" for `..` — the parent folder, which of course exists.
const nameProblem = computed(() => (trimmed.value && !valid.value ? t('modal.invalidName') : null));


async function submit() {
  if (!valid.value) return;
  try {
    await files.createFolder(trimmed.value);
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
  <Modal :title="t('modal.newFolder.title')" :close-label="t('modal.cancel')" :initial-focus="input?.el" @close="emit('close')">
    <Input ref="input" v-model="name" :height="44" :label="t('modal.newFolder.title')" @enter="submit" @update:model-value="error = null" />
    <p v-if="error || nameProblem" class="mt-2 text-11 leading-none text-danger" role="alert">{{ error ?? nameProblem }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!valid" class="disabled:opacity-50" @click="submit">{{ t('modal.newFolder.create') }}</Button>
    </template>
  </Modal>
</template>
