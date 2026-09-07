<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Users } from 'lucide-vue-next';
import ListingPage from '@/features/files/ListingPage.vue';

const { t } = useI18n();
</script>

<template>
  <ListingPage
    listing="shared"
    :title="t('nav.shared')"
    :columns="['sharedBy', 'sharedOn', 'fileSize']"
    :empty-icon="Users"
    :empty-title="t('empty.shared.title')"
    :empty-hint="t('empty.shared.hint')"
  />
</template>
