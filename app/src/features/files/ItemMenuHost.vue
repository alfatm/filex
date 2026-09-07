<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { itemMenuEntries } from '@/pages/files/itemMenu';
import FloatingMenu from '@/ui/FloatingMenu.vue';
import { MENU_WIDTH, useItemMenuStore } from './itemMenuStore';
import { useFileActions } from './useFileActions';

const { t } = useI18n();
const menu = useItemMenuStore();
const actions = useFileActions();

const entries = computed(() => (menu.state ? itemMenuEntries(t, menu.state.node) : []));

function onSelect(id: string) {
  const node = menu.state?.node;
  menu.close();
  if (node) void actions.run(id, node);
}
</script>

<template>
  <FloatingMenu
    v-if="menu.state"
    :items="entries"
    :x="menu.state.x"
    :y="menu.state.y"
    :width="MENU_WIDTH"
    :label="t('files.more')"
    @select="onSelect"
    @close="menu.close()"
  />
</template>
