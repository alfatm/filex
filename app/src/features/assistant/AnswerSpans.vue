<script setup lang="ts">
/**
 * One line of an answer. Every span becomes a real element — the assistant
 * renders no HTML the model wrote (see answer.ts).
 */
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { repository } from '@/data';
import type { Span } from './answer';
import { splitAddress } from './answer';
import { useFileActions } from '@/features/files/useFileActions';
import { joinPath, filesRoute, segments } from '@/lib/path';
import { useFilesStore } from '@/stores/files';

defineProps<{ spans: Span[] }>();

const { t } = useI18n();
const router = useRouter();
const files = useFilesStore();
const actions = useFileActions();

/**
 * An address on the drive the app currently shows is a link; one on another
 * drive is not, because there is nowhere to send the reader yet. It stays
 * visible as the address the assistant wrote rather than becoming a button
 * that does nothing.
 */
function reachable(address: string): boolean {
  const parts = splitAddress(address);
  return !!parts && !!files.storage && parts.drive === files.storage.id;
}

/**
 * Opens what the address names: a file previews in place, a folder opens.
 * The kind is not in the address, so it is read off the parent listing — the
 * one lookup that works the same on both repositories.
 */
async function open(address: string) {
  const parsed = splitAddress(address);
  if (!parsed || !files.storage) return;
  const path = segments(parsed.path);
  const name = path.at(-1);
  if (name) {
    try {
      const parent = await repository.resolvePath(files.storage.id, joinPath(path.slice(0, -1)));
      const node = (await repository.listFolder(parent.id)).nodes.find((n) => n.name === name);
      if (node?.kind === 'file') {
        actions.preview(node, [node]);
        return;
      }
    } catch {
      // The parent is gone as well; the folder page below says so in its own words.
    }
  }
  await router.push(filesRoute(parsed.drive, path));
}
</script>

<template>
  <template v-for="(span, at) in spans" :key="at">
    <strong v-if="span.kind === 'strong'" class="font-semibold">{{ span.text }}</strong>
    <em v-else-if="span.kind === 'em'">{{ span.text }}</em>
    <code v-else-if="span.kind === 'code'" class="rounded-sm bg-bg px-1 font-code text-11">{{ span.text }}</code>
    <a
      v-else-if="span.kind === 'link'"
      :href="span.href"
      target="_blank"
      rel="noopener noreferrer"
      class="break-all text-primary underline underline-offset-2 hover:text-primary-hover"
      >{{ span.text }}</a>
    <button
      v-else-if="span.kind === 'path' && reachable(span.text)"
      type="button"
      :title="t('assistant.openPath')"
      class="break-all text-left text-primary underline underline-offset-2 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring"
      @click="open(span.text)"
    >
      {{ span.text }}
    </button>
    <code v-else-if="span.kind === 'path'" class="break-all rounded-sm bg-bg px-1 font-code text-11">{{ span.text }}</code>
    <template v-else>{{ span.text }}</template>
  </template>
</template>
