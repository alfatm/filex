<script setup lang="ts">
import type { Node } from '@/data/types';
import FileTypeTile from '@/pages/files/FileTypeTile.vue';
import FolderIcon from '@/pages/files/FolderIcon.vue';
import Thumbnail from '@/pages/files/Thumbnail.vue';

/** Folder glyph / image thumb / type tile at `size` px, the same look as the file table. */
withDefaults(defineProps<{ node: Node; size?: number }>(), { size: 32 });
</script>

<template>
  <FolderIcon v-if="node.kind === 'folder'" :width="size" :height="Math.round(size * 0.8125)" :shared="node.shared" />
  <span
    v-else-if="node.fileType === 'image' && node.thumbnail"
    class="shrink-0 overflow-hidden rounded-sm"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <Thumbnail :kind="node.thumbnail" :src="node.thumbUrl" />
  </span>
  <FileTypeTile v-else :type="node.fileType ?? 'other'" :size="size" />
</template>
