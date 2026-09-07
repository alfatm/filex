<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, HardDrive, Search } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { subjectMessage } from '@/i18n/subject';
import FolderIcon from '@/pages/files/FolderIcon.vue';
import { useFilesStore } from '@/stores/files';
import { Button, Input, Select } from '@/ui';
import Modal from '@/ui/Modal.vue';

const props = defineProps<{ nodes: Node[] }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();

interface Row {
  node: Node;
  depth: number;
  disabled: boolean;
  /** Ancestor chain shown beside the name while the list is filtered (the tree indentation is gone then). */
  location?: string;
}

const storageId = ref(files.storage?.id ?? '');
const storageOptions = computed(() => files.storages.map((s) => ({ value: s.id, label: s.name })));
const folders = ref<Node[]>([]);
const filter = ref('');
const targetId = ref<string | null>(null);
const INDENT = 22;

const moving = computed(() => new Set(props.nodes.map((n) => n.id)));
const parents = computed(() => new Set(props.nodes.map((n) => n.parentId)));

// Depth-first from the root; a moved folder and everything inside it cannot be a target, nor can the current parent.
const tree = computed<Row[]>(() => {
  const out: Row[] = [];
  const walk = (parentId: string | null, depth: number, blocked: boolean) => {
    for (const node of folders.value.filter((n) => n.parentId === parentId)) {
      const inside = blocked || moving.value.has(node.id);
      out.push({ node, depth, disabled: inside || parents.value.has(node.id) });
      walk(node.id, depth + 1, inside);
    }
  };
  walk(null, 0, false);
  return out;
});

function locationOf(node: Node): string {
  const names: string[] = [];
  for (let p = node.parentId; p !== null; ) {
    const parent = folders.value.find((n) => n.id === p);
    if (!parent) break;
    names.unshift(parent.name);
    p = parent.parentId;
  }
  return `/${names.join('/')}`;
}

// A filter flattens the tree to the matching folders, each with its location; the root stays out (its name is the storage).
const rows = computed<Row[]>(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return tree.value;
  return tree.value
    .filter((row) => row.depth > 0 && row.node.name.toLowerCase().includes(needle))
    .map((row) => ({ ...row, depth: 0, location: locationOf(row.node) }));
});

const target = computed(() => folders.value.find((n) => n.id === targetId.value) ?? null);

watch(
  storageId,
  async (id) => {
    targetId.value = null;
    folders.value = id ? await repository.listFolders(id) : [];
  },
  { immediate: true },
);

async function submit() {
  if (!target.value) return;
  await files.move(props.nodes, target.value);
  emit('close');
}
</script>

<template>
  <Modal :title="subjectMessage(t, 'modal.move.title', nodes)" :close-label="t('modal.cancel')" @close="emit('close')">
    <div class="flex gap-3">
      <Select v-model="storageId" :options="storageOptions" :icon="HardDrive" :width="200" :label="t('modal.move.storage')" />
      <Input v-model="filter" type="search" :icon="Search" class="flex-1" :placeholder="t('modal.move.filter')" :label="t('modal.move.filter')" />
    </div>
    <ul role="listbox" :aria-label="t('modal.move.destination')" class="mt-3 max-h-[320px] overflow-y-auto rounded-md border border-border py-1">
      <li v-for="row in rows" :key="row.node.id">
        <button
          type="button"
          role="option"
          :aria-selected="targetId === row.node.id"
          :disabled="row.disabled"
          class="flex h-10 w-full items-center text-15 leading-none disabled:text-text-3"
          :class="targetId === row.node.id ? 'bg-primary-soft' : 'enabled:hover:bg-hover-row'"
          :style="{ paddingLeft: `${12 + row.depth * INDENT}px` }"
          @click="targetId = row.node.id"
        >
          <ChevronRight :size="14" class="mr-1 shrink-0" :class="row.depth === 0 ? 'invisible' : 'text-text-3'" />
          <FolderIcon :width="24" :height="20" :shared="row.node.shared" class="mr-3 shrink-0" />
          <span class="truncate">{{ row.node.name }}</span>
          <span v-if="row.location" class="ml-3 truncate text-13 text-text-3">{{ row.location }}</span>
        </button>
      </li>
      <li v-if="!rows.length" class="px-3 py-6 text-center text-15 text-text-3">{{ t('modal.move.noMatch') }}</li>
    </ul>
    <template #footer>
      <Button variant="outline" @click="emit('close')">{{ t('modal.cancel') }}</Button>
      <Button :disabled="!target" class="disabled:opacity-50" @click="submit">{{ t('modal.move.confirm') }}</Button>
    </template>
  </Modal>
</template>
