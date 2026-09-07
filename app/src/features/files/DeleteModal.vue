<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Node } from '@/data/types';
import { subjectMessage } from '@/i18n/subject';
import { useFilesStore } from '@/stores/files';
import { Button } from '@/ui';
import Modal from '@/ui/Modal.vue';
import type { DeleteVariant } from './modalsStore';

const props = defineProps<{ variant: DeleteVariant; nodes: Node[] }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();

// Empty trash has no subject; its body is a plain sentence.
const body = computed(() =>
  props.variant === 'emptyTrash' ? t('modal.delete.emptyTrash.body') : subjectMessage(t, `modal.delete.${props.variant}.body`, props.nodes),
);

async function confirm() {
  switch (props.variant) {
    case 'trash':
      await files.trash(props.nodes);
      break;
    case 'forever':
      await files.deleteForever(props.nodes);
      break;
    case 'emptyTrash':
      await files.emptyTrash();
      break;
  }
  emit('close');
}
</script>

<template>
  <Modal :title="t(`modal.delete.${variant}.title`)" :close-label="t('modal.cancel')" @close="emit('close')">
    <p class="text-15 leading-[22px] text-text-2">{{ body }}</p>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :class="variant !== 'trash' && '!bg-danger hover:!bg-danger hover:brightness-95'" @click="confirm">
        {{ t(`modal.delete.${variant}.confirm`) }}
      </Button>
    </template>
  </Modal>
</template>
