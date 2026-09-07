<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Clock } from 'lucide-vue-next';
import type { Node } from '@/data/types';
import ListingPage from '@/features/files/ListingPage.vue';
import { formatRelativeDay } from '@/lib/format';

const { t, locale } = useI18n();
// Grouped by the same date the listing is ordered by: the last open, else the modification.
const byDay = (node: Node) => formatRelativeDay(node.openedAt ?? node.modifiedAt, locale.value, t);
</script>

<template>
  <ListingPage
    listing="recent"
    :title="t('nav.recent')"
    :filters="['type', 'people']"
    :group-by="byDay"
    :sortable="false"
    :empty-icon="Clock"
    :empty-title="t('empty.recent.title')"
    :empty-hint="t('empty.recent.hint')"
  />
</template>
