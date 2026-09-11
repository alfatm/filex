<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CalendarClock, CalendarPlus, X } from 'lucide-vue-next';
import { useFormat } from '@/composables/useFormat';
import { repository } from '@/data';
import { AROUND_SPANS, type AroundSpan, type DateWindow } from '@/data/types';
import { reportUnhandled } from '@/lib/errors';
import { useFilesStore } from '@/stores/files';
import FloatingMenu, { anchorBelow, type FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

/**
 * The filters that have no chip of their own: the tags, the MIME type and the date window the details panel sets.
 *
 * They appear only once set — there is no "any tag" to offer from a cold start — but once they are on screen they
 * behave like the chips beside them: the body opens a menu that edits the value, and the `X` takes the filter off.
 * A chip whose only gesture removed it was a filter you could not adjust without going back to the panel.
 *
 * Each chip's menu is its own question. A tag's is the drive's whole vocabulary, so one tag can be swapped for
 * another; a date window's is which date it reads and how wide it is. The MIME chip has none — the server publishes
 * no list of the types a drive holds, and a menu of one entry is not a choice — so it only shows and removes.
 */
const { t } = useI18n();
const { formatDate } = useFormat();
const files = useFilesStore();

const MENU_WIDTH = 200;
const CHIP = 'inline-flex h-control-sm items-center border-primary bg-primary-soft text-12 leading-none text-primary hover:bg-primary-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring';

/** Which chip's menu is open, and where it goes. `tag` carries the tag being edited. */
const menu = ref<{ kind: 'around' | 'tag'; tag?: string; x: number; y: number } | null>(null);
/** The drive's tags, read when a tag menu is first opened rather than on every listing. */
const allTags = ref<string[]>([]);

const around = computed(() => files.filter.around);
/**
 * The chip carries a DATE, not a sentence: "Created within a day of Sep 11, 2026" is wider than the three menus
 * beside it put together, and it pushed the name box off the row. The icon says which date it is.
 */
const aroundIcon = computed(() => (around.value?.field === 'created' ? CalendarPlus : CalendarClock));

/** Field then width, one list: both are the same question — which window this chip means. */
const aroundItems = computed<FloatingMenuEntry[]>(() => {
  const current = around.value;
  if (!current) return [];
  return [
    ...(['modified', 'created'] as DateWindow['field'][]).map((field) => ({
      id: `field:${field}`,
      label: t(`filter.around.field.${field}`),
      checked: current.field === field,
    })),
    ...AROUND_SPANS.map((span, i) => ({
      id: `span:${span}`,
      label: t(`filter.around.span.${span}`),
      checked: current.span === span,
      dividerBefore: i === 0,
    })),
  ];
});

const tagItems = computed<FloatingMenuEntry[]>(() => {
  if (!allTags.value.length) return [{ id: '', label: t('panel.noTags'), disabled: true }];
  // A tag already in the filter is offered but inert: swapping this chip onto it would make two chips for one tag.
  return allTags.value.map((tag) => ({
    id: tag,
    label: tag,
    checked: tag === menu.value?.tag,
    disabled: files.filter.tags.includes(tag) && tag !== menu.value?.tag,
  }));
});

function openAround(event: MouseEvent) {
  menu.value = { kind: 'around', ...anchorBelow(event.currentTarget as HTMLElement, MENU_WIDTH) };
}

async function openTag(event: MouseEvent, tag: string) {
  menu.value = { kind: 'tag', tag, ...anchorBelow(event.currentTarget as HTMLElement, MENU_WIDTH) };
  if (allTags.value.length) return;
  try {
    allTags.value = await repository.listAllTags();
  } catch (error) {
    // The menu then has nothing to offer, which is what it says; the filter itself is untouched.
    reportUnhandled(error);
  }
}

function pick(id: string) {
  const open = menu.value;
  menu.value = null;
  if (!open) return;
  if (open.kind === 'tag') {
    if (!id) return;
    // A swap, not an addition: this chip IS one tag, and the others in the filter stay where they are.
    void files.setFilter({ ...files.filter, tags: files.filter.tags.map((tag) => (tag === open.tag ? id : tag)) });
    return;
  }
  const current = files.filter.around;
  if (!current) return;
  const [key, value] = id.split(':');
  const next: DateWindow = key === 'field' ? { ...current, field: value as DateWindow['field'] } : { ...current, span: value as AroundSpan };
  // A window and the Modified chip's preset are two windows over one column, so setting this one drops that one.
  void files.setFilter({ ...files.filter, around: next, modified: 'any' });
}

function dropTag(tag: string) {
  void files.setFilter({ ...files.filter, tags: files.filter.tags.filter((item) => item !== tag) });
}

function dropMime() {
  void files.setFilter({ ...files.filter, mime: '' });
}

function dropAround() {
  void files.setFilter({ ...files.filter, around: null });
}
</script>

<template>
  <!-- Two buttons in one chip-shaped frame: the body edits, the `X` removes. -->
  <div v-if="around" class="inline-flex max-w-[200px] items-center">
    <button
      type="button"
      :class="[CHIP, 'min-w-0 rounded-l border-y border-l pl-2.5 pr-1.5']"
      aria-haspopup="menu"
      :aria-expanded="menu?.kind === 'around'"
      :title="t(`filter.around.${around.field}`, { date: formatDate(around.at), span: t(`filter.around.spanOf.${around.span}`) })"
      @click="openAround($event)"
    >
      <component :is="aroundIcon" :size="13" class="mr-1 shrink-0" />
      <span class="truncate">{{ t('filter.around.short', { date: formatDate(around.at), span: t(`filter.around.spanShort.${around.span}`) }) }}</span>
    </button>
    <button type="button" :class="[CHIP, 'rounded-r border-y border-r pl-1 pr-2']" :aria-label="t('filter.remove')" @click="dropAround()">
      <X :size="14" />
    </button>
  </div>

  <!-- The MIME chip has no menu: there is no list of the drive's types to swap between, so the whole chip removes it. -->
  <div v-if="files.filter.mime" class="inline-flex max-w-[200px] items-center">
    <span :class="[CHIP, 'min-w-0 rounded-l border-y border-l pl-2.5 pr-1.5']" :title="t('filter.mimeTitle', { mime: files.filter.mime })">
      <span class="truncate">{{ files.filter.mime }}</span>
    </span>
    <button type="button" :class="[CHIP, 'rounded-r border-y border-r pl-1 pr-2']" :aria-label="t('filter.remove')" @click="dropMime()">
      <X :size="14" />
    </button>
  </div>

  <div v-for="tag in files.filter.tags" :key="tag" class="inline-flex max-w-[200px] items-center">
    <button
      type="button"
      :class="[CHIP, 'min-w-0 rounded-l border-y border-l pl-2.5 pr-1.5']"
      aria-haspopup="menu"
      :aria-expanded="menu?.kind === 'tag' && menu.tag === tag"
      :title="t('filter.tagTitle', { tag })"
      @click="openTag($event, tag)"
    >
      <span class="truncate">{{ t('filter.tagChip', { tag }) }}</span>
    </button>
    <button type="button" :class="[CHIP, 'rounded-r border-y border-r pl-1 pr-2']" :aria-label="t('filter.remove')" @click="dropTag(tag)">
      <X :size="14" />
    </button>
  </div>

  <FloatingMenu
    v-if="menu"
    :items="menu.kind === 'around' ? aroundItems : tagItems"
    :x="menu.x"
    :y="menu.y"
    :width="MENU_WIDTH"
    :label="t(menu.kind === 'around' ? 'filter.around.edit' : 'filter.tagEdit')"
    @select="pick"
    @close="menu = null"
  />
</template>
