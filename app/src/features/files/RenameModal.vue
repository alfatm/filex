<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Node } from '@/data/types';
import { DUPLICATE_NAME } from '@/data/repository';
import { useFilesStore } from '@/stores/files';
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
const valid = computed(() => trimmed.value.length > 0 && trimmed.value !== props.node.name);

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
    error.value = e instanceof Error && e.message === DUPLICATE_NAME ? t('modal.duplicateName') : String(e instanceof Error ? e.message : e);
    return;
  }
  emit('close');
}
</script>

<template>
  <Modal :title="t('modal.rename.title')" :close-label="t('modal.cancel')" :initial-focus="input?.el" @close="emit('close')">
    <Input ref="input" v-model="name" :height="44" :label="t('modal.rename.title')" @enter="submit" @update:model-value="error = null" />
    <p v-if="error" class="mt-2 text-13 leading-none text-danger" role="alert">{{ error }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!valid" class="disabled:opacity-50" @click="submit">{{ t('modal.rename.confirm') }}</Button>
    </template>
  </Modal>
</template>
