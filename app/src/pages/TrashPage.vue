<script setup lang="ts">
import { computed } from 'vue';
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

/** Purging needs both: an install that offers it, and a role that carries it — with a sentence each. */
const purgeAllowed = computed(() => capabilities.can.deleteForever && capabilities.allows('files.purge'));
const purgeHint = computed(() =>
  purgeAllowed.value ? undefined : capabilities.can.deleteForever ? t('common.notAllowed') : t('common.unavailable'),
);

const DAY_MS = 24 * 60 * 60 * 1000;
/** What the banner says on a server that reports no countdown at all — filex's own default, and what it said before. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * How long this install keeps deleted items, which is what the banner promises.
 *
 * filex reports the days LEFT per row rather than the policy behind them, so the policy is that number plus the
 * days the row has already sat there. Every row that has not expired yet gives the same answer; an expired one is
 * pinned at zero and would over-report, so the smallest answer is the honest one. The literal "30 days" this used
 * to print was simply wrong on any install that changed `trash.retention_days`.
 */
const retentionDays = computed(() => {
  const answers = files.ordered.flatMap((node) =>
    node.ttlDays === undefined || !node.deletedAt ? [] : [node.ttlDays + Math.max(0, Math.floor((Date.now() - Date.parse(node.deletedAt)) / DAY_MS))],
  );
  return answers.length ? Math.min(...answers) : DEFAULT_RETENTION_DAYS;
});
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
        <p class="ml-3 flex-1 text-15 leading-none text-text-2">{{ t('trash.banner', { days: retentionDays }) }}</p>
        <!-- Emptying the trash is admin-only in filex today; the snapshot decides whether the button can act. -->
        <Button
          variant="outline"
          :disabled="!files.ordered.length || !purgeAllowed"
          :title="purgeHint"
          class="disabled:opacity-50"
          @click="modals.open({ kind: 'delete', variant: 'emptyTrash', nodes: [] })"
        >
          {{ t('trash.empty') }}
        </Button>
      </div>
    </template>
  </ListingPage>
</template>
