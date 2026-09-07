<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { History } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node, Version } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { Button } from '@/ui';
import Modal from '@/ui/Modal.vue';

/** Revisions of one file. Restoring an older one makes its content current again and keeps everything in between. */
const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatDateTime, formatSize } = useFormat();
const files = useFilesStore();
const toast = useToastStore();

const versions = ref<Version[]>([]);
const busy = ref(false);

async function load() {
  versions.value = await repository.listVersions(props.node.id);
}

onMounted(load);

async function restore(version: Version) {
  busy.value = true;
  try {
    await repository.restoreVersion(props.node.id, version.id);
    await files.refresh();
    await load();
    toast.push(t('modal.versions.restored', { date: formatDateTime(version.at) }));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal :title="t('modal.versions.title')" :close-label="t('modal.close')" :width="560" @close="emit('close')">
    <p class="text-14 leading-tight text-text-3">{{ t('modal.versions.hint', { name: node.name }) }}</p>

    <ul v-if="versions.length" class="mt-4 divide-y divide-border-soft" :aria-label="t('modal.versions.title')">
      <li v-for="version in versions" :key="version.id" class="flex h-[58px] items-center">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-2">
          <History :size="18" />
        </span>
        <div class="ml-3 min-w-0 flex-1">
          <p class="flex items-center gap-2">
            <span class="truncate-safe text-15 leading-none">{{ formatDateTime(version.at) }}</span>
            <span
              v-if="version.current"
              class="flex h-[22px] shrink-0 items-center rounded-full bg-primary-soft px-2 text-12 font-medium leading-none text-primary"
            >
              {{ t('modal.versions.current') }}
            </span>
          </p>
          <p class="mt-1.5 truncate-safe text-13 leading-none text-text-3">
            {{ t('modal.versions.by', { name: version.authorName, size: formatSize(version.size) }) }}
          </p>
        </div>
        <Button v-if="!version.current" variant="outline" :disabled="busy" class="ml-3 shrink-0 disabled:opacity-50" @click="restore(version)">
          {{ t('modal.versions.restore') }}
        </Button>
      </li>
    </ul>
    <p v-else class="mt-4 text-15 leading-none text-text-3">{{ t('modal.versions.empty') }}</p>

    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.done') }}</Button>
    </template>
  </Modal>
</template>
