<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Info, Trash2 } from 'lucide-vue-next';
import ListingPage from '@/features/files/ListingPage.vue';
import { useModalsStore } from '@/features/files/modalsStore';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { Button } from '@/ui';

const { t } = useI18n();
const files = useFilesStore();
const modals = useModalsStore();
const capabilities = useCapabilitiesStore();
</script>

<template>
  <ListingPage
    listing="trash"
    :title="t('nav.trash')"
    :filters="['type', 'modified']"
    :columns="['deleted', 'originalPath', 'fileSize']"
    :empty-icon="Trash2"
    :empty-title="t('empty.trash.title')"
    :empty-hint="t('empty.trash.hint')"
  >
    <template #banner>
      <div class="mr-[9px] mt-4 flex h-14 items-center rounded-lg border border-border bg-bg-muted pl-4 pr-2">
        <Info :size="20" class="shrink-0 text-text-2" />
        <p class="ml-3 flex-1 text-15 leading-none text-text-2">{{ t('trash.banner') }}</p>
        <!-- Emptying the trash is admin-only in filex today; the snapshot decides whether the button can act. -->
        <Button
          variant="outline"
          :disabled="!files.ordered.length || !capabilities.can.deleteForever"
          :title="capabilities.can.deleteForever ? undefined : t('common.unavailable')"
          class="disabled:opacity-50"
          @click="modals.open({ kind: 'delete', variant: 'emptyTrash', nodes: [] })"
        >
          {{ t('trash.empty') }}
        </Button>
      </div>
    </template>
  </ListingPage>
</template>
