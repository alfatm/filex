<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Star } from 'lucide-vue-next';
import ListingPage from '@/features/files/ListingPage.vue';

const { t } = useI18n();
</script>

<template>
  <ListingPage
    listing="starred"
    :columns="['location', 'lastModified', 'fileSize']"
    :title="t('nav.starred')"
    :empty-icon="Star"
    :empty-title="t('empty.starred.title')"
    :empty-hint="t('empty.starred.hint')"
  />
</template>
