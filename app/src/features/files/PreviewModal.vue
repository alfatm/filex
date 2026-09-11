<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Maximize, Minus, Plus, Share2, Star, X } from 'lucide-vue-next';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { useFormat } from '@/composables/useFormat';
// The Markdown parser and renderer the assistant answers with. It is the app's one Markdown reader: a safe block
// parser with no `v-html` behind it, and a `.md` file is untrusted text for exactly the same reason an answer is.
import AnswerText from '@/features/assistant/AnswerText.vue';
import FileTypeTile from '@/pages/files/FileTypeTile.vue';
import { useFilesStore } from '@/stores/files';
import { CSV_MAX_ROWS, parseCsv, previewKind, splitLines } from './preview';
import ShareModal from './ShareModal.vue';

/**
 * Full-screen preview of `nodes[index]` (files only, in listing order); ← → and the chevrons walk the list.
 * Every file shown counts as opened (`repository.recordOpen`), which is what the Recent page orders by.
 */
const props = defineProps<{ nodes: Node[]; index: number }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { formatDate, formatSize } = useFormat();
const files = useFilesStore();

/** The native PDF viewer gets this long to fire `load`; then the download card takes its place. */
const PDF_TIMEOUT_MS = 3000;
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const index = ref(props.index);
const current = computed(() => props.nodes[index.value]);
const kind = computed(() => previewKind(current.value));
const download = computed(() => (current.value.kind === 'file' ? repository.downloadUrl(current.value.id) : undefined));
const hasPrevious = computed(() => index.value > 0);
const hasNext = computed(() => index.value < props.nodes.length - 1);

const meta = computed(() => {
  const parts = [formatSize(current.value.size), formatDate(current.value.modifiedAt)];
  if (props.nodes.length > 1) parts.push(t('preview.counter', { index: index.value + 1, count: props.nodes.length }));
  return parts.join(' • ');
});

// Star state is local: the listing refresh replaces the nodes behind `props.nodes`, not the copies held here.
const starred = ref(current.value.starred);
const sharing = ref(false);

// Free zoom/pan of the image preview: the wheel scales around the cursor, dragging pans, double-click resets.
const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
/** Wheel delta (px) to log-scale factor; one notch (~100px) is about 1.16x. */
const ZOOM_SENSITIVITY = 0.0015;

const scale = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const panning = ref(false);
let panOrigin = { x: 0, y: 0, offsetX: 0, offsetY: 0 };

const zoomLabel = computed(() => `${Math.round(scale.value * 100)}%`);

/** What one press of the zoom buttons does. The wheel is continuous; the buttons are a step, and this is its size. */
const ZOOM_STEP = 1.25;

/**
 * Zooms about the CENTRE of the box, which is where the transform is anchored — so the pan offset has to scale
 * with it, or a zoomed-and-panned image jumps when a button is pressed.
 */
function zoomBy(factor: number) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor));
  const ratio = next / scale.value;
  offsetX.value *= ratio;
  offsetY.value *= ratio;
  scale.value = next;
}

function resetZoom() {
  scale.value = 1;
  offsetX.value = 0;
  offsetY.value = 0;
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  // Cursor relative to the box centre, which is where the image transform is anchored.
  const cursorX = event.clientX - (box.left + box.width / 2);
  const cursorY = event.clientY - (box.top + box.height / 2);
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * Math.exp(-event.deltaY * ZOOM_SENSITIVITY)));
  const ratio = next / scale.value;
  // Keep the image point under the cursor in place.
  offsetX.value = cursorX - (cursorX - offsetX.value) * ratio;
  offsetY.value = cursorY - (cursorY - offsetY.value) * ratio;
  scale.value = next;
}

function onPanStart(event: PointerEvent) {
  if (event.button !== 0) return;
  panning.value = true;
  panOrigin = { x: event.clientX, y: event.clientY, offsetX: offsetX.value, offsetY: offsetY.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPanMove(event: PointerEvent) {
  if (!panning.value) return;
  offsetX.value = panOrigin.offsetX + (event.clientX - panOrigin.x);
  offsetY.value = panOrigin.offsetY + (event.clientY - panOrigin.y);
}

function onPanEnd(event: PointerEvent) {
  if (!panning.value) return;
  panning.value = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}

// Fetched content of text-like files.
type Status = 'loading' | 'ready' | 'error';
const status = ref<Status>('loading');
const lines = ref<string[]>([]);
/** The Markdown source of a `.md` file; `AnswerText` parses and draws it. */
const markdown = ref('');
const rows = ref<string[][]>([]);
const csvTruncated = computed(() => rows.value.length > CSV_MAX_ROWS);
const pdfFailed = ref(false);
/** The browser refused the codec: the player draws nothing useful, so the card says so and offers the file. */
const audioFailed = ref(false);
let pdfTimer: ReturnType<typeof setTimeout> | undefined;
let fetchSeq = 0;

async function loadText(node: Node) {
  const seq = ++fetchSeq;
  status.value = 'loading';
  try {
    const response = await fetch(node.assetUrl!);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    if (seq !== fetchSeq) return;
    if (kind.value === 'csv') rows.value = parseCsv(text);
    else if (kind.value === 'markdown') markdown.value = text;
    else lines.value = splitLines(text);
    status.value = 'ready';
  } catch {
    if (seq === fetchSeq) status.value = 'error';
  }
}

function armPdfTimeout() {
  clearTimeout(pdfTimer);
  pdfFailed.value = false;
  pdfTimer = setTimeout(() => (pdfFailed.value = true), PDF_TIMEOUT_MS);
}

function onPdfLoad() {
  clearTimeout(pdfTimer);
}

watch(
  current,
  (node) => {
    starred.value = node.starred;
    resetZoom();
    audioFailed.value = false;
    lines.value = [];
    rows.value = [];
    markdown.value = '';
    void repository.recordOpen(node.id);
    if (kind.value === 'text' || kind.value === 'csv' || kind.value === 'markdown') void loadText(node);
    if (kind.value === 'pdf') armPdfTimeout();
  },
  { immediate: true },
);

onBeforeUnmount(() => clearTimeout(pdfTimer));

function step(delta: 1 | -1) {
  const next = index.value + delta;
  if (next >= 0 && next < props.nodes.length) index.value = next;
}

function onKeydown(event: KeyboardEvent) {
  // A player's own keys (seek, and space for play/pause) win while it has focus.
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'VIDEO' || tag === 'AUDIO') return;
  if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'ArrowRight') step(1);
  else return;
  event.preventDefault();
}

async function toggleStar() {
  const next = !starred.value;
  await files.setStarred([current.value], next);
  starred.value = next;
}

const ACTION_CLASS =
  'inline-flex h-10 w-10 items-center justify-center rounded-md text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring';
const CHEVRON_CLASS =
  'absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring';
const ZOOM_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-full text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring';
const CLOSE_CLASS =
  'inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/30 hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-ring';
</script>

<template>
  <!-- The dialog root is the full-screen box itself (not a zero-size wrapper), so tools see it as visible. -->
  <Dialog open class="fixed inset-0 z-40" @close="emit('close')">
    <!-- The only hard-coded colour: the overlay is darker than the modal token so images read against it. -->
    <div class="absolute inset-0" style="background: rgba(17, 24, 39, 0.9)" aria-hidden="true" />
    <DialogPanel class="absolute inset-0 flex flex-col" @keydown="onKeydown">
      <header class="flex h-16 shrink-0 items-center gap-4 pl-5 pr-3">
        <div class="flex min-w-0 flex-1 items-center">
          <FileTypeTile :type="current.fileType ?? 'other'" :size="36" />
          <div class="ml-3 min-w-0">
            <DialogTitle as="p" class="truncate-safe text-13 font-medium leading-none text-white">{{ current.name }}</DialogTitle>
            <p class="mt-1 truncate-safe text-11 leading-none text-white/70">{{ meta }}</p>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <a v-if="download" :href="download" :download="current.name" :class="ACTION_CLASS" :aria-label="t('preview.download')" :title="t('preview.download')">
            <Download :size="20" />
          </a>
          <button type="button" :class="ACTION_CLASS" :aria-label="t('preview.share')" :title="t('preview.share')" @click="sharing = true">
            <Share2 :size="20" />
          </button>
          <button
            type="button"
            :class="ACTION_CLASS"
            :aria-label="t(starred ? 'preview.unstar' : 'preview.star')"
            :title="t(starred ? 'preview.unstar' : 'preview.star')"
            :aria-pressed="starred"
            @click="toggleStar"
          >
            <Star :size="20" :fill="starred ? 'currentColor' : 'none'" :class="starred && 'text-folder'" />
          </button>
          <a
            v-if="current.assetUrl"
            :href="current.assetUrl"
            target="_blank"
            rel="noopener"
            :class="ACTION_CLASS"
            :aria-label="t('preview.openInNewTab')"
            :title="t('preview.openInNewTab')"
          >
            <ExternalLink :size="20" />
          </a>
        </div>
        <div class="flex flex-1 justify-end">
          <button type="button" :class="CLOSE_CLASS" :aria-label="t('preview.close')" :title="t('preview.close')" @click="emit('close')">
            <X :size="24" />
          </button>
        </div>
      </header>

      <div class="relative flex min-h-0 flex-1 items-center justify-center">
        <template v-if="nodes.length > 1">
          <button type="button" :class="[CHEVRON_CLASS, 'left-5']" :disabled="!hasPrevious" class="disabled:opacity-30" :aria-label="t('preview.previous')" @click="step(-1)">
            <ChevronLeft :size="24" />
          </button>
          <button type="button" :class="[CHEVRON_CLASS, 'right-5']" :disabled="!hasNext" class="disabled:opacity-30" :aria-label="t('preview.next')" @click="step(1)">
            <ChevronRight :size="24" />
          </button>
        </template>

        <div
          v-if="kind === 'image'"
          class="absolute inset-0 flex touch-none items-center justify-center overflow-hidden"
          :class="panning ? 'cursor-grabbing' : 'cursor-grab'"
          @wheel="onWheel"
          @pointerdown="onPanStart"
          @pointermove="onPanMove"
          @pointerup="onPanEnd"
          @pointercancel="onPanEnd"
          @dblclick="resetZoom"
        >
          <img
            :key="current.id"
            :src="current.assetUrl"
            :alt="current.name"
            draggable="false"
            class="max-h-full max-w-full select-none object-contain"
            :style="{ transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})` }"
          />
          <!-- The wheel zooms and dragging pans, but neither is discoverable and neither exists on a touchpad-less
               machine or a tablet; these are the same three moves with a control on them. `stop` on the clicks:
               the box below them pans on pointerdown and resets on double-click. -->
          <div
            class="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/10 p-1 backdrop-blur"
            @pointerdown.stop
            @dblclick.stop
            @wheel.stop
          >
            <button type="button" :class="ZOOM_BUTTON_CLASS" :aria-label="t('preview.zoomOut')" :title="t('preview.zoomOut')" @click="zoomBy(1 / ZOOM_STEP)">
              <Minus :size="16" />
            </button>
            <p class="w-14 text-center text-11 leading-none text-white/80 tabular-nums" aria-live="off">{{ zoomLabel }}</p>
            <button type="button" :class="ZOOM_BUTTON_CLASS" :aria-label="t('preview.zoomIn')" :title="t('preview.zoomIn')" @click="zoomBy(ZOOM_STEP)">
              <Plus :size="16" />
            </button>
            <button type="button" :class="ZOOM_BUTTON_CLASS" :aria-label="t('preview.zoomFit')" :title="t('preview.zoomFit')" @click="resetZoom">
              <Maximize :size="16" />
            </button>
          </div>
        </div>

        <video v-else-if="kind === 'video'" :key="current.id" :src="current.assetUrl" controls autoplay muted playsinline class="max-h-[80vh] max-w-[90vw] rounded-lg" />

        <!-- Sound has nothing to show, so the card carries the file's identity and the browser's own transport. -->
        <div v-else-if="kind === 'audio'" class="flex w-[420px] max-w-[90vw] flex-col items-center rounded-2xl bg-bg p-[26px] text-center shadow-modal">
          <FileTypeTile :type="current.fileType ?? 'other'" :size="56" />
          <p class="mt-4 max-w-full truncate text-13 font-medium text-text">{{ current.name }}</p>
          <p class="mt-1 text-11.5 leading-none text-text-3">{{ formatSize(current.size) }}</p>
          <!-- `preload="metadata"` so the controls know the duration before anything is played; no autoplay —
               a preview that starts making noise on its own is not what opening a folder asked for. -->
          <audio
            v-if="!audioFailed"
            :key="current.id"
            :src="current.assetUrl"
            controls
            preload="metadata"
            class="mt-5 w-full"
            :aria-label="current.name"
            @error="audioFailed = true"
          />
          <p v-else class="mt-4 text-13 text-text-2">{{ t('preview.audioError') }}</p>
          <a v-if="download" :href="download" :download="current.name" class="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-13 font-medium text-white hover:bg-primary-hover">
            <Download :size="18" />{{ t('preview.download') }}
          </a>
        </div>

        <iframe
          v-else-if="kind === 'pdf' && !pdfFailed"
          :key="current.id"
          :src="current.assetUrl"
          :title="current.name"
          class="h-[80vh] w-[80vw] rounded-lg bg-bg"
          @load="onPdfLoad"
        />

        <template v-else-if="kind === 'text' || kind === 'csv' || kind === 'markdown'">
          <p v-if="status === 'loading'" class="text-13 text-white/70" role="status">{{ t('preview.loading') }}</p>
          <div v-else-if="status === 'error'" class="w-[420px] rounded-2xl bg-bg p-[26px] text-center shadow-modal">
            <p class="text-13 text-text">{{ t('preview.loadError') }}</p>
            <a v-if="download" :href="download" :download="current.name" class="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-13 font-medium text-white hover:bg-primary-hover">
              <Download :size="18" />{{ t('preview.download') }}
            </a>
          </div>
          <div v-else class="max-h-[80vh] w-[80vw] overflow-auto rounded-lg bg-bg text-text">
            <table v-if="kind === 'csv'" class="w-full border-collapse text-11.5">
              <thead v-if="rows.length">
                <tr class="border-b border-border bg-bg-muted">
                  <th v-for="(cell, c) in rows[0]" :key="c" class="whitespace-nowrap px-3 py-2 text-left font-semibold text-text-2">{{ cell }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, r) in rows.slice(1, CSV_MAX_ROWS + 1)" :key="r" class="border-b border-border-soft">
                  <td v-for="(cell, c) in row" :key="c" class="whitespace-nowrap px-3 py-1.5">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="kind === 'csv' && csvTruncated" class="px-3 py-2 text-11 text-text-3">{{ t('preview.csvTruncated', { count: CSV_MAX_ROWS }) }}</p>
            <!-- Narrower than the code view on purpose: prose is read in a column, not across 80vw of screen. -->
            <AnswerText v-if="kind === 'markdown'" :text="markdown" class="mx-auto max-w-[72ch] px-6 py-5" />
            <pre v-if="kind === 'text'" class="py-3 text-[13px] leading-5" :style="{ fontFamily: MONO_FONT }"><ol class="list-none"><li v-for="(line, i) in lines" :key="i" class="flex"><span class="w-14 shrink-0 select-none pr-4 text-right text-text-3" aria-hidden="true">{{ i + 1 }}</span><span class="whitespace-pre pr-4">{{ line }}</span></li></ol></pre>
          </div>
        </template>

        <div v-else class="flex w-[420px] flex-col items-center rounded-2xl bg-bg p-[26px] text-center shadow-modal">
          <FileTypeTile :type="current.fileType ?? 'other'" :size="56" />
          <p class="mt-4 max-w-full truncate text-13 font-medium text-text">{{ current.name }}</p>
          <p class="mt-1 text-11.5 leading-none text-text-3">{{ formatSize(current.size) }}</p>
          <p class="mt-4 text-13 text-text-2">{{ kind === 'pdf' ? t('preview.pdfFallback') : t('preview.noPreview') }}</p>
          <a v-if="download" :href="download" :download="current.name" class="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-13 font-medium text-white hover:bg-primary-hover">
            <Download :size="18" />{{ t('preview.download') }}
          </a>
        </div>
      </div>
    </DialogPanel>

    <ShareModal v-if="sharing" :node="current" @close="sharing = false" />
  </Dialog>
</template>
