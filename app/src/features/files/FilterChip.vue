<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FILE_TYPE_GROUPS, MODIFIED_PRESETS, SIZE_PRESETS, type ListingFilter } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { Chip } from '@/ui';
import FloatingMenu, { anchorBelow, type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';
import { FILTER_WIDTHS, type FilterId } from './filters';

/**
 * One filter chip (spec §3). The value lives in the store's `ListingFilter` and the repository applies it, so
 * picking an option reloads the listing exactly as the HTTP repository will.
 */
const props = defineProps<{ id: FilterId }>();

const { t } = useI18n();
const files = useFilesStore();

const MENU_WIDTH = 224;
const ANY = 'any';
const menu = ref<{ x: number; y: number } | null>(null);

const options = computed<{ value: string; label: string }[]>(() => {
  switch (props.id) {
    case 'type':
      return FILE_TYPE_GROUPS.map((value) => ({ value, label: t(`search.typeOptions.${value}`) }));
    case 'modified':
      return MODIFIED_PRESETS.map((value) => ({ value, label: t(`search.modifiedOptions.${value}`) }));
    case 'size':
      // "Custom" needs the two byte fields of the advanced search form; the chip offers the presets only.
      return SIZE_PRESETS.filter((value) => value !== 'custom').map((value) => ({ value, label: t(`search.sizeOptions.${value}`) }));
    default:
      return [
        { value: ANY, label: t('filter.anyone') },
        ...files.filterPeople.map((person) => ({
          value: person.id,
          label: person.id === files.user?.id ? t('panel.you') : person.name,
        })),
      ];
  }
});

/** The chip's value as a menu id: every filter uses "any" for "not set", including the person one. */
const current = computed(() => {
  switch (props.id) {
    case 'type':
      return files.filter.fileType;
    case 'modified':
      return files.filter.modified;
    case 'size':
      return files.filter.size;
    default:
      return files.filter.personId ?? ANY;
  }
});

const active = computed(() => current.value !== ANY);
const label = computed(() => (active.value ? (options.value.find((o) => o.value === current.value)?.label ?? '') : t(`filter.${props.id}`)));
const items = computed<FloatingMenuEntry[]>(() =>
  options.value.map((option) => ({ id: option.value, label: option.label, checked: option.value === current.value })),
);

function pick(value: string) {
  menu.value = null;
  const next: ListingFilter = { ...files.filter };
  if (props.id === 'type') next.fileType = value as ListingFilter['fileType'];
  else if (props.id === 'modified') next.modified = value as ListingFilter['modified'];
  else if (props.id === 'size') next.size = value as ListingFilter['size'];
  else next.personId = value === ANY ? null : value;
  void files.setFilter(next);
}
</script>

<template>
  <div class="contents">
    <Chip
      :label="label"
      :width="FILTER_WIDTHS[id]"
      :active="active"
      aria-haspopup="menu"
      :aria-expanded="!!menu"
      @click="menu = anchorBelow($event.currentTarget as HTMLElement, MENU_WIDTH)"
    />
    <FloatingMenu
      v-if="menu"
      :items="items"
      :x="menu.x"
      :y="menu.y"
      :width="MENU_WIDTH"
      :label="t(`filter.${id}`)"
      @select="pick"
      @close="menu = null"
    />
  </div>
</template>
