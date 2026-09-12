<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Download, FileText, Maximize2 } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import type { AssistantReport } from '@/data/types';
import { Button, IconButton } from '@/ui';
import Modal from '@/ui/Modal.vue';
import AnswerText from './AnswerText.vue';
import { reportCsv, reportFileName, reportText, saveReport } from './report';

const props = defineProps<{ report: AssistantReport }>();

const { t } = useI18n();
const { formatSize, formatDate } = useFormat();

/** The card keeps the list off the panel — that is what it is for; the modal is where the rows are read. */
const expanded = ref(false);

function downloadText() {
  saveReport(reportText(props.report), reportFileName(props.report, 'txt'), 'text/plain;charset=utf-8');
}

function downloadCsv() {
  saveReport(reportCsv(props.report), reportFileName(props.report, 'csv'), 'text/csv;charset=utf-8');
}
</script>

<template>
  <article :aria-label="report.title" class="rounded-2xl border border-border-soft bg-bg-muted p-4">
    <div class="flex items-start gap-3">
      <FileText :size="22" class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-13 font-medium leading-snug">{{ report.title }}</p>
        <p v-if="report.rows.length" class="mt-1 text-11 leading-none text-text-3">{{ t('assistant.report.files', report.rows.length) }}</p>
      </div>
      <IconButton :label="t('assistant.report.expand')" :size="28" class="-mr-1 -mt-1 shrink-0 text-text-2" @click="expanded = true">
        <Maximize2 :size="16" />
      </IconButton>
    </div>
    <AnswerText v-if="report.text" :text="report.text" class="mt-3" />
    <div class="mt-3 flex flex-wrap gap-[10px]">
      <Button variant="outline" @click="downloadText">
        <Download :size="16" aria-hidden="true" />
        {{ t('assistant.report.downloadText') }}
      </Button>
      <Button v-if="report.rows.length" variant="outline" @click="downloadCsv">
        <Download :size="16" aria-hidden="true" />
        {{ t('assistant.report.downloadCsv') }}
      </Button>
    </div>
  </article>

  <Modal v-if="expanded" :title="report.title" :close-label="t('modal.close')" :width="720" @close="expanded = false">
    <AnswerText v-if="report.text" :text="report.text" />
    <ul v-if="report.rows.length" :class="{ 'mt-3': report.text }">
      <li v-for="{ node } in report.rows" :key="node.id" class="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0">
        <div class="min-w-0 flex-1">
          <p class="truncate-safe text-11.5 font-medium leading-snug">{{ node.name }}</p>
          <p class="truncate-safe text-11 leading-snug text-text-3">{{ node.id }}</p>
        </div>
        <span v-if="node.kind === 'file'" class="shrink-0 text-11 text-text-3">{{ formatSize(node.size) }}</span>
        <span v-if="node.modifiedAt" class="shrink-0 text-11 text-text-3">{{ formatDate(node.modifiedAt) }}</span>
      </li>
    </ul>
    <template #footer>
      <Button variant="outline" @click="downloadText">{{ t('assistant.report.downloadText') }}</Button>
      <Button v-if="report.rows.length" @click="downloadCsv">{{ t('assistant.report.downloadCsv') }}</Button>
    </template>
  </Modal>
</template>
