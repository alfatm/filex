<script setup lang="ts">
/**
 * "How to connect" — the outward half of the shared connections surface.
 *
 * Not written here. `ConnectionsPanel` is the same file the admin panel mounts (`web/src/views/Connections.vue`)
 * and the desktop app mounts as `<filex-connections>`; the guides in it are generated from the live deployment,
 * with the real host, the caller's own username and the storage names they can see. A hand-written copy for this
 * surface is exactly what the package exists to prevent.
 *
 * `initial-tab="connect"` opens on that outward half. The inward one — connecting filex TO a bucket or a share —
 * is an admin job, and the panel already tells a non-admin so instead of rendering a form whose every submit 403s.
 */
import { useI18n } from 'vue-i18n';
import { ConnectionsPanel } from '@brftech/filex-core';
import '@brftech/filex-core/style.css';
import { useCoreConfig } from '@/lib/coreConfig';

const { t } = useI18n();
const config = useCoreConfig();
</script>

<template>
  <main class="min-w-0 flex-1 overflow-y-auto pb-8 pl-[29px] pr-8 pt-[18px]">
    <h1 class="pl-[11px] text-22 font-semibold leading-none">{{ t('nav.howToConnect') }}</h1>
    <div class="mt-[22px] pl-[11px]">
      <ConnectionsPanel :config="config" initial-tab="connect" />
    </div>
  </main>
</template>
