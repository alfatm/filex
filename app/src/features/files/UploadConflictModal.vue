<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { nameOf } from '@/lib/address';
import { Button, Checkbox } from '@/ui';
import Modal from '@/ui/Modal.vue';
import type { ConflictAnswer, UploadItem } from './uploadStore';

/**
 * The question a refused upload asks (spec §7): the name is taken, or somebody is uploading to it right now. One
 * row at a time — the store hands over the first one waiting — and closing it is Skip, the answer that changes
 * nothing. `offerAll` shows the "apply to all" box, which only means something while more rows are still to come.
 */
const props = defineProps<{ item: UploadItem; offerAll: boolean }>();
const emit = defineEmits<{ decide: [answer: ConflictAnswer, applyToAll: boolean] }>();
const { t } = useI18n();

const busy = computed(() => props.item.conflict === 'inProgress');
/** A folder's id is its address, so its name is the last segment; the drive root has none and is named by its drive. */
const folder = computed(() => nameOf(props.item.parentId) || props.item.parentId.split('://')[0]);
const applyToAll = ref(false);

function answer(choice: ConflictAnswer) {
  emit('decide', choice, applyToAll.value);
}
</script>

<template>
  <Modal
    :title="busy ? t('upload.busyTitle', { name: item.name }) : t('upload.conflictTitle', { name: item.name })"
    :close-label="t('upload.skip')"
    @close="answer('skip')"
  >
    <p class="text-13 leading-[22px] text-text-2">
      {{ busy ? t('upload.busyBody', { name: item.name, folder }) : t('upload.conflictBody', { name: item.name, folder }) }}
    </p>
    <Checkbox v-if="offerAll" v-model="applyToAll" class="mt-4" :label="t('upload.applyAll')" show-label />
    <template #footer>
      <Button variant="outline" @click="answer('skip')">{{ t('upload.skip') }}</Button>
      <Button variant="outline" @click="answer('keepBoth')">{{ t('upload.keepBoth') }}</Button>
      <Button v-if="busy" @click="answer('retry')">{{ t('upload.retry') }}</Button>
      <Button v-else class="!bg-danger hover:!bg-danger hover:brightness-95" @click="answer('replace')">{{ t('upload.replace') }}</Button>
    </template>
  </Modal>
</template>
