<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { CircleAlert, CircleCheck } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import { repository } from '@/data';
import { fileTypeOf } from '@/data/fileTypes';
import type { PlanCard, PlanItem, PlanResult } from '@/data/types';
import { nameOf, parentPath } from '@/lib/address';
import { useFileActions } from '@/features/files/useFileActions';
import FileTypeTile from '@/pages/files/FileTypeTile.vue';
import FolderIcon from '@/pages/files/FolderIcon.vue';
import Thumbnail from '@/pages/files/Thumbnail.vue';
import { itemAction } from './plan';

/**
 * The body of a plan: every item it would touch, and — once it ran — what happened to each. Drawn twice from the
 * same component, in the card (capped in height, scrolling) and in the modal that opens it in full.
 */
const props = defineProps<{
  card: PlanCard;
  /** Height cap for the list; it scrolls inside it. */
  listClass?: string;
}>();

const { t } = useI18n();
const { formatDate, formatSize } = useFormat();
// The same copy the share modal uses, so a minted link is copied and announced exactly the way any other link is.
const { copyLink } = useFileActions();

/** Spec §6: a 40px picture per line — the file itself for an image, the type tile for anything else. */
const THUMB_PX = 40;

/** A skip or a failure, in the reader's language; an unknown code falls back to the server's English sentence. */
const RESULT_CODES = ['gone', 'changed', 'forbidden', 'missing', 'broken', 'taken'] as const;

function resultReason(result: PlanResult) {
  if (result.code && (RESULT_CODES as readonly string[]).includes(result.code)) return t(`assistant.plan.reason.${result.code}`);
  return result.reason ?? '';
}

/**
 * The numbers of the item as it stands. Which ones matter depends on the plan — a version has a size and when it
 * was taken, a trashed file has a size and when it was deleted, a link has a date and a download count.
 */
function itemDetail(item: PlanItem) {
  const card = props.card;
  const size = item.size ? formatSize(item.size) : '';
  const at = item.at ? formatDate(item.at) : '';
  if (card.planKind === 'empty_trash' && at) return t('assistant.plan.detail.deleted', { size, at });
  if (card.planKind === 'restore_version' && at) return t('assistant.plan.detail.taken', { size, at });
  if (card.planKind === 'revoke_share' && at) return t('assistant.plan.detail.link', { at, downloads: item.args?.downloads ?? '0' });
  // A file that already has links is worth saying so before a second one is approved.
  if (card.planKind === 'create_share') {
    const existing = Number(item.args?.existing ?? 0);
    return existing > 0 ? [size, t('assistant.plan.detail.alreadyShared', existing)].filter(Boolean).join(' · ') : size;
  }
  return size;
}

/**
 * One line per item: the name in front, and under it everything that makes the line readable on its own — the
 * numbers, the folder (two files may share a name) and what will happen. Once the plan ran, the outcome joins it.
 */
const rows = computed(() => {
  const results = new Map((props.card.results ?? []).map((r) => [r.path, r]));
  return props.card.items.map((item) => {
    const folder = item.action === 'mkdir' ? null : (parentPath(item.path) ?? null);
    const result = results.get(item.path);
    const outcome = result && result.state !== 'done' ? resultReason(result) : '';
    return {
      item,
      name: nameOf(item.path) || item.path,
      folder,
      fileType: item.action === 'mkdir' ? null : fileTypeOf(nameOf(item.path)),
      previewUrl: item.action === 'mkdir' ? undefined : repository.previewUrl(item.path),
      detail: [itemDetail(item), folder, itemAction(item, t), outcome].filter(Boolean).join(' · '),
      state: result?.state,
      url: result?.url,
    };
  });
});
</script>

<template>
  <ul class="mt-3 overflow-y-auto" :class="listClass">
    <li v-for="row in rows" :key="row.item.path" class="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0">
      <!-- A picture is the fastest way to tell which file this is; the check on the right is its fate. -->
      <FolderIcon v-if="!row.fileType" :width="THUMB_PX" :height="Math.round(THUMB_PX * 0.8125)" class="mx-0" />
      <span
        v-else-if="row.fileType === 'image'"
        class="shrink-0 overflow-hidden rounded-lg bg-bg-muted"
        :style="{ width: `${THUMB_PX}px`, height: `${THUMB_PX}px` }"
      >
        <Thumbnail kind="mountain" :src="row.previewUrl" />
      </span>
      <FileTypeTile v-else :type="row.fileType" :size="THUMB_PX" class="!rounded-lg" />

      <span class="min-w-0 flex-1">
        <span class="block truncate text-14 font-medium leading-snug text-text" :title="row.item.path">{{ row.name }}</span>
        <span class="block break-words text-13 leading-snug text-text-3">{{ row.detail }}</span>
        <!--
          The one plan that hands something back. The URL is the whole point of approving it, so it is
          shown in full and selectable rather than behind a "copy" button that a screen reader has to
          guess at. Not an anchor: it is a credential to hand on, not a place this panel should navigate.
        -->
        <span v-if="row.url" class="mt-1 flex items-start gap-2">
          <code class="min-w-0 flex-1 select-all break-all font-code text-12 text-text">{{ row.url }}</code>
          <button type="button" class="shrink-0 text-13 text-primary hover:underline" @click="copyLink(row.url)">
            {{ t('assistant.plan.copyLink') }}
          </button>
        </span>
      </span>

      <CircleAlert v-if="row.state && row.state !== 'done'" :size="20" class="shrink-0 text-danger" aria-hidden="true" />
      <CircleCheck v-else :size="20" class="shrink-0" :class="row.state === 'done' ? 'text-success' : 'text-border-hover'" aria-hidden="true" />
    </li>
  </ul>
  <p v-if="card.status === 'done'" class="mt-3 text-13 leading-none text-success">{{ t('assistant.plan.ran') }}</p>
</template>
