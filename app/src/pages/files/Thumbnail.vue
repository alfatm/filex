<script setup lang="ts">
import { ref, useId } from 'vue';
import { Play } from 'lucide-vue-next';
import type { ThumbnailKind } from '@/data/types';

/** `src` is the real image / video (Node.assetUrl); without it, or once it fails to load, the placeholder paints. */
defineProps<{ kind: ThumbnailKind; duration?: string; src?: string }>();
// Several thumbnails render on one page; an SVG gradient id must be unique in the document.
const skyId = useId();
const failed = ref(false);
/** Read from the video's metadata; the node's label shows until then. */
const realDuration = ref<string | null>(null);

const POSTER_SECOND = 1;

function onVideoMetadata(event: Event) {
  const video = event.target as HTMLVideoElement;
  const total = Math.round(video.duration);
  const pad = (n: number) => String(n).padStart(2, '0');
  realDuration.value = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  // The frame at one second stands in for a poster.
  video.currentTime = Math.min(POSTER_SECOND, video.duration);
}
</script>

<template>
  <!-- Real files render when the demo assets are served; otherwise placeholder artwork (mock content only). -->
  <div class="relative h-full w-full overflow-hidden">
    <img v-if="src && kind !== 'video' && !failed" :src="src" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover" @error="failed = true" />

    <svg v-else-if="kind === 'mountain'" viewBox="0 0 236 108" preserveAspectRatio="none" class="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient :id="skyId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#bfdbfe" />
          <stop offset="1" stop-color="#e0f2fe" />
        </linearGradient>
      </defs>
      <rect width="236" height="108" :fill="`url(#${skyId})`" />
      <polygon points="0,108 70,34 120,78 160,44 236,108" fill="#475569" />
      <polygon points="0,108 40,70 90,108" fill="#1e293b" />
      <polygon points="150,108 200,60 236,108" fill="#334155" />
      <polygon points="70,34 60,46 80,46" fill="#f8fafc" />
    </svg>

    <div v-else-if="kind === 'beach'" class="h-full w-full" style="background: linear-gradient(180deg, #7dd3fc 0%, #38bdf8 46%, #0ea5e9 62%, #fde68a 64%, #fcd34d 100%)" />

    <div v-else-if="kind === 'code'" class="h-full w-full bg-[#1e293b] px-4 py-4 font-mono text-[11px] leading-[20px]">
      <div><span class="text-[#c084fc]">import</span> <span class="text-[#e2e8f0]">{ ref }</span> <span class="text-[#c084fc]">from</span> <span class="text-[#86efac]">'vue'</span></div>
      <div><span class="text-[#93c5fd]">const</span> <span class="text-[#e2e8f0]">count</span> <span class="text-[#94a3b8]">=</span> <span class="text-[#fcd34d]">ref</span><span class="text-[#e2e8f0]">(</span><span class="text-[#fb923c]">0</span><span class="text-[#e2e8f0]">)</span></div>
      <div><span class="text-[#93c5fd]">export</span> <span class="text-[#93c5fd]">default</span> <span class="text-[#e2e8f0]">{ count }</span></div>
    </div>

    <div v-else-if="kind === 'document' || kind === 'pdf'" class="flex h-full w-full items-start justify-center bg-bg-muted pt-3">
      <div class="h-[120px] w-[150px] rounded-t-sm bg-white px-4 pt-4 shadow-menu">
        <div class="h-[6px] rounded-full" :class="kind === 'pdf' ? 'w-16 bg-text' : 'w-20 bg-text-2'" />
        <div class="mt-2.5 space-y-1.5">
          <div class="h-[3px] w-full rounded-full bg-border" />
          <div class="h-[3px] w-full rounded-full bg-border" />
          <div class="h-[3px] w-4/5 rounded-full bg-border" />
          <div class="h-[3px] w-full rounded-full bg-border" />
          <div class="h-[3px] w-3/5 rounded-full bg-border" />
        </div>
      </div>
    </div>

    <svg v-else-if="kind === 'figma'" viewBox="0 0 236 108" class="h-full w-full bg-[#f5f3ff]" aria-hidden="true">
      <rect x="28" y="24" width="56" height="60" rx="8" fill="#a259ff" />
      <circle cx="132" cy="54" r="26" fill="#1abcfe" />
      <rect x="172" y="30" width="40" height="48" rx="6" fill="#f24e1e" />
      <rect x="92" y="70" width="60" height="14" rx="7" fill="#0acf83" />
    </svg>

    <svg v-else-if="kind === 'spreadsheet'" viewBox="0 0 236 108" class="h-full w-full bg-white" aria-hidden="true">
      <rect width="236" height="20" fill="#dcfce7" />
      <g stroke="#e5e7eb" stroke-width="1">
        <line v-for="i in 5" :key="`h${i}`" x1="0" :y1="i * 20" x2="236" :y2="i * 20" />
        <line v-for="i in 4" :key="`v${i}`" :x1="i * 59" y1="0" :x2="i * 59" y2="108" />
      </g>
      <g fill="#9ca3af">
        <rect v-for="i in 8" :key="`c${i}`" :x="8 + (i % 4) * 59" :y="27 + Math.floor((i - 1) / 4) * 40" width="32" height="5" rx="2" />
      </g>
    </svg>

    <div v-else-if="kind === 'video'" class="relative flex h-full w-full items-center justify-center" style="background: linear-gradient(135deg, #312e81 0%, #1e1b4b 100%)">
      <video
        v-if="src && !failed"
        :src="src"
        preload="metadata"
        muted
        playsinline
        class="absolute inset-0 h-full w-full object-cover"
        @loadedmetadata="onVideoMetadata"
        @error="failed = true"
      />
      <span class="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-[#1e1b4b]">
        <Play :size="20" fill="currentColor" :stroke-width="0" class="ml-0.5" />
      </span>
      <span
        v-if="realDuration ?? duration"
        class="absolute bottom-2 right-2 rounded-sm px-1.5 py-0.5 text-12 font-medium leading-none text-white"
        style="background: rgba(0, 0, 0, 0.65)"
        >{{ realDuration ?? duration }}</span>
    </div>
  </div>
</template>
