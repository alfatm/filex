<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { History } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node, Version } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { errorMessage } from '@/lib/errors';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { Button } from '@/ui';
import Modal from '@/ui/Modal.vue';

/**
 * Revisions of one file. Every row is content the file USED to hold — filex snapshots the bytes before overwriting
 * them, so the live file has no row of its own — and restoring one snapshots the live bytes first, which is why
 * every row here can be restored and why the list grows by one when a rollback happens.
 */
const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const toast = useToastStore();

const versions = ref<Version[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);

async function load() {
  try {
    versions.value = await repository.listVersions(props.node.id);
    error.value = null;
  } catch (e) {
    // "A folder keeps no revisions" is the wrong sentence for a list that never arrived, so the list stays as it
    // was and the failure is said instead.
    error.value = errorMessage(e);
  }
}

onMounted(load);

async function restore(version: Version) {
  busy.value = true;
  error.value = null;
  try {
    await repository.restoreVersion(props.node.id, version.id);
    await files.refresh();
    await load();
    toast.push(t('modal.versions.restored', { date: formatDateTime(version.at) }));
  } catch (e) {
    // Nothing was restored, so nothing is announced; the row keeps its button and the reason is on screen.
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="t('modal.versions.title')" :close-label="t('modal.close')" :width="560" @close="emit('close')">
    <p class="text-11.5 leading-tight text-text-3">{{ t('modal.versions.hint', { name: node.name }) }}</p>

    <ul v-if="versions.length" class="mt-4 divide-y divide-border-soft" :aria-label="t('modal.versions.title')">
      <li v-for="version in versions" :key="version.id" class="flex h-[58px] items-center">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-2">
          <History :size="18" />
        </span>
        <div class="ml-3 min-w-0 flex-1">
          <p class="truncate-safe text-13 leading-none">{{ formatDateTime(version.at) }}</p>
          <p class="mt-1.5 truncate-safe text-11 leading-none text-text-3">
            {{ version.authorName ? t('modal.versions.by', { name: version.authorName, size: formatSize(version.size) }) : formatSize(version.size) }}
          </p>
        </div>
        <Button variant="outline" :disabled="busy" class="ml-3 shrink-0 disabled:opacity-50" @click="restore(version)">
          {{ t('modal.versions.restore') }}
        </Button>
      </li>
    </ul>
    <p v-else-if="!error" class="mt-4 text-13 leading-none text-text-3">{{ t('modal.versions.empty') }}</p>
    <p v-if="error" class="mt-4 text-11 leading-none text-danger" role="alert">{{ error }}</p>

    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.done') }}</Button>
    </template>
  </Modal>
</template>
