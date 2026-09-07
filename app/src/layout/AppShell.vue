<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { useViewStore } from '@/stores/view';
import Sidebar from './Sidebar.vue';
import ToastHost from './ToastHost.vue';
import TopBar from './TopBar.vue';

// Loaded on first open: the panel and its store are not part of the initial bundle.
const AssistantPanel = defineAsyncComponent(() => import('@/features/assistant/AssistantPanel.vue'));

const view = useViewStore();
</script>

<template>
  <div class="flex h-screen w-full overflow-hidden bg-bg text-text">
    <Sidebar />
    <div class="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <!-- Pages own this area: content column plus the optional details panel. -->
      <div class="flex min-h-0 flex-1">
        <slot />
      </div>
    </div>
    <!-- Full height beside the topbar (spec §6: header at the topbar's level, search box shrinks). -->
    <AssistantPanel v-if="view.assistantOpen" @close="view.assistantOpen = false" />
    <ToastHost />
  </div>
</template>
