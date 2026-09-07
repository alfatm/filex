<script setup lang="ts">
import AccessModal from './AccessModal.vue';
import DeleteModal from './DeleteModal.vue';
import MoveModal from './MoveModal.vue';
import NewFolderModal from './NewFolderModal.vue';
import PreviewModal from './PreviewModal.vue';
import RenameModal from './RenameModal.vue';
import ShareModal from './ShareModal.vue';
import TagsModal from './TagsModal.vue';
import VersionsModal from './VersionsModal.vue';
import { useModalsStore } from './modalsStore';

const modals = useModalsStore();
</script>

<template>
  <template v-if="modals.active">
    <NewFolderModal v-if="modals.active.kind === 'newFolder'" @close="modals.close()" />
    <RenameModal v-else-if="modals.active.kind === 'rename'" :key="modals.active.node.id" :node="modals.active.node" @close="modals.close()" />
    <ShareModal v-else-if="modals.active.kind === 'share'" :node="modals.active.node" @close="modals.close()" />
    <MoveModal v-else-if="modals.active.kind === 'move'" :nodes="modals.active.nodes" @close="modals.close()" />
    <TagsModal v-else-if="modals.active.kind === 'tags'" :key="modals.active.node.id" :node="modals.active.node" @close="modals.close()" />
    <VersionsModal v-else-if="modals.active.kind === 'versions'" :key="modals.active.node.id" :node="modals.active.node" @close="modals.close()" />
    <AccessModal v-else-if="modals.active.kind === 'access'" :key="modals.active.node.id" :node="modals.active.node" @close="modals.close()" />
    <DeleteModal v-else-if="modals.active.kind === 'delete'" :variant="modals.active.variant" :nodes="modals.active.nodes" @close="modals.close()" />
    <PreviewModal v-else-if="modals.active.kind === 'preview'" :nodes="modals.active.nodes" :index="modals.active.index" @close="modals.close()" />
  </template>
</template>
