<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Switch } from '@headlessui/vue';
import { Copy, Link } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { errorMessage } from '@/lib/errors';
import { useFilesStore } from '@/stores/files';
import { Button, IconButton } from '@/ui';
import Modal from '@/ui/Modal.vue';
import { useFileActions } from './useFileActions';

const props = defineProps<{ node: Node }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const files = useFilesStore();
const actions = useFileActions();

// Read once when the modal opens, then held from the mutation results: a listing row knows THAT a node is shared,
// not what the link is — filex hands the URL out per node, and only to the person who minted it.
const url = ref<string | null>(null);
/**
 * Whether the CURRENT link is known.
 *
 * Until it is, the switch stays off — and off is also what it shows for a node that has a link the read could not
 * fetch, so toggling it on there would mint a SECOND link for the same node. The switch is therefore disabled
 * rather than merely wrong.
 */
const loaded = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    url.value = await repository.shareLink(props.node.id);
  } catch (e) {
    error.value = errorMessage(e);
    return;
  }
  loaded.value = true;
});

async function toggle(on: boolean) {
  error.value = null;
  try {
    if (on) url.value = await files.createShareLink(props.node.id);
    else {
      await files.removeShareLink(props.node.id);
      url.value = null;
    }
  } catch (e) {
    // The switch is bound to `url`, so it snaps back to what the node really has the moment this returns.
    error.value = errorMessage(e);
  }
}
</script>

<template>
  <Modal :title="t('modal.share.title', { name: node.name })" :close-label="t('modal.close')" @close="emit('close')">
    <div class="flex items-center">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-2">
        <Link :size="18" />
      </span>
      <div class="ml-3 min-w-0 flex-1">
        <p class="text-13 font-medium leading-none">{{ t('modal.share.linkSharing') }}</p>
        <p class="mt-1 text-11.5 leading-none text-text-3">{{ url ? t('modal.share.anyoneCanView') : t('modal.share.off') }}</p>
      </div>
      <Switch
        :model-value="!!url"
        :disabled="!loaded"
        :aria-label="t('modal.share.linkSharing')"
        class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring disabled:opacity-50"
        :class="url ? 'bg-primary' : 'bg-border-hover'"
        @update:model-value="toggle"
      >
        <span class="inline-block h-5 w-5 rounded-full bg-white shadow-menu transition" :class="url ? 'translate-x-[22px]' : 'translate-x-0.5'" />
      </Switch>
    </div>
    <p v-if="error" class="mt-3 text-11 leading-none text-danger" role="alert">{{ error }}</p>
    <div v-if="url" class="mt-4 flex h-11 items-center rounded-md border border-border bg-bg-muted pl-4 pr-1">
      <span class="min-w-0 flex-1 truncate-safe text-13 leading-none">{{ url }}</span>
      <IconButton :label="t('panel.copy')" :size="36" class="hover:bg-bg" @click="actions.copyLink(url)"><Copy :size="18" /></IconButton>
    </div>
    <template #footer>
      <Button @click="emit('close')">{{ t('modal.done') }}</Button>
    </template>
  </Modal>
</template>
