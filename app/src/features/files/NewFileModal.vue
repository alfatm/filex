<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { DUPLICATE_NAME, FileLimitExceeded, ROLE_FORBIDDEN, UploadRateLimited } from '@/data/repository';
import { useFilesStore } from '@/stores/files';
import { Button, Input } from '@/ui';
import Modal from '@/ui/Modal.vue';

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();

const name = ref(t('modal.newFile.defaultName'));
const input = ref<InstanceType<typeof Input>>();
const trimmed = computed(() => name.value.trim());
const error = ref<string | null>(null);
const valid = computed(() => trimmed.value.length > 0);

// The offered name is highlighted up to its extension, so typing replaces "Untitled" and keeps the ".txt".
onMounted(async () => {
  await nextTick();
  const dot = name.value.lastIndexOf('.');
  input.value?.focus();
  input.value?.select(0, dot > 0 ? dot : name.value.length);
});

/**
 * A new file is a write like an upload is, so it meets the same refusals — a taken name, the file ceiling, the
 * rolling upload window, and a role that may not write here. Each has its own sentence; anything else is shown in
 * the server's own words, as in New folder.
 */
function message(e: unknown): string {
  if (e instanceof FileLimitExceeded) return t('upload.fileLimit', { limit: e.limit.toLocaleString() });
  // Minutes rather than seconds: the number is the server's estimate of when the window frees up.
  if (e instanceof UploadRateLimited) return t('upload.rateLimited', { wait: t('upload.retryInMinutes', { minutes: Math.max(1, Math.ceil(e.retryAfterSeconds / 60)) }) });
  if (e instanceof Error && e.message === DUPLICATE_NAME) return t('modal.duplicateName');
  if (e instanceof Error && e.message === ROLE_FORBIDDEN) return t('common.notAllowed');
  return e instanceof Error ? e.message : String(e);
}

async function submit() {
  if (!valid.value) return;
  try {
    await files.createFile(trimmed.value);
  } catch (e) {
    error.value = message(e);
    return;
  }
  emit('close');
}
</script>

<template>
  <Modal :title="t('modal.newFile.title')" :close-label="t('modal.cancel')" :initial-focus="input?.el" @close="emit('close')">
    <Input ref="input" v-model="name" :height="44" :label="t('modal.newFile.title')" @enter="submit" @update:model-value="error = null" />
    <p v-if="error" class="mt-2 text-11 leading-none text-danger" role="alert">{{ error }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!valid" class="disabled:opacity-50" @click="submit">{{ t('modal.newFile.create') }}</Button>
    </template>
  </Modal>
</template>
