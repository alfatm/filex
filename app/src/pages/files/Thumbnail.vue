<script setup lang="ts">
import { ref, useId } from 'vue';
import { Play } from 'lucide-vue-next';
import type { ThumbnailKind } from '@/data/types';

/** `src` is the server's cached preview (Node.thumbUrl); without it, or once it fails to load, the placeholder paints. */
defineProps<{ kind: ThumbnailKind; duration?: string; src?: string }>();
// Several thumbnails render on one page; an SVG gradient id must be unique in the document.
const skyId = useId();
const figId = useId();
const CARD_SHADOW = 'filter: drop-shadow(0 1.5px 2px rgba(76, 29, 149, 0.12))';
const failed = ref(false);
</script>

<template>
  <!-- The cached preview when the server has one; otherwise placeholder artwork per kind. -->
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

    <!-- A design canvas: the tool's layer panel wired to the frame it edits, with the swatches and the empty slot beside it. -->
    <svg v-else-if="kind === 'figma'" viewBox="0 0 236 108" class="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient :id="figId" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#c4b5fd" />
          <stop offset="1" stop-color="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="236" height="108" fill="#f5f3ff" />

      <!-- Out-of-focus ground: the blobs and the layout guides the frames are snapped to. -->
      <g>
        <circle cx="8" cy="98" r="46" fill="#c4b5fd" opacity="0.45" />
        <circle cx="72" cy="14" r="30" fill="#ddd6fe" opacity="0.75" />
        <circle cx="216" cy="4" r="26" fill="#fecdd3" opacity="0.75" />
        <circle cx="226" cy="102" r="34" fill="#bfdbfe" opacity="0.6" />
      </g>
      <g stroke="#c4b5fd" stroke-width="0.7" stroke-dasharray="4 3" opacity="0.35">
        <line x1="49" y1="0" x2="49" y2="108" />
        <line x1="137" y1="0" x2="137" y2="108" />
        <line x1="0" y1="66" x2="236" y2="66" />
      </g>

      <!-- Layer panel: the Figma mark above three layer rows. -->
      <g :style="CARD_SHADOW">
        <rect x="12" y="20" width="30" height="68" rx="6" fill="#ffffff" />
        <path d="M27 26h-1.75a1.75 1.75 0 0 0 0 3.5H27Z" fill="#f24e1e" />
        <path d="M27 26h1.75a1.75 1.75 0 0 1 0 3.5H27Z" fill="#ff7262" />
        <path d="M27 29.5h-1.75a1.75 1.75 0 0 0 0 3.5H27Z" fill="#a259ff" />
        <circle cx="28.75" cy="31.25" r="1.75" fill="#1abcfe" />
        <path d="M27 33h-1.75a1.75 1.75 0 0 0 0 3.5H27Z" fill="#0acf83" />
        <g fill="#e5e7eb">
          <circle v-for="i in 3" :key="`fl${i}`" cx="21" :cy="46 + (i - 1) * 11" r="3" />
          <rect v-for="i in 3" :key="`fb${i}`" x="28" :y="44.5 + (i - 1) * 11" width="9" height="3" rx="1.5" />
        </g>
      </g>

      <!-- The wire from the panel to the frame it drives. -->
      <path d="M40 44c8 0 3 18 12 18" fill="none" stroke="#7c3aed" stroke-width="1.6" />
      <circle cx="40" cy="44" r="2.6" fill="#ffffff" stroke="#7c3aed" stroke-width="1.6" />
      <circle cx="52" cy="62" r="2.6" fill="#7c3aed" stroke="#ffffff" stroke-width="1.2" />

      <!-- The frame under edit. -->
      <g :style="CARD_SHADOW">
        <rect x="58" y="12" width="74" height="84" rx="8" fill="#ffffff" />
        <circle cx="67" cy="22" r="4" fill="#e5e7eb" />
        <rect x="75" y="20" width="22" height="4" rx="2" fill="#e5e7eb" />
        <rect x="64" y="31" width="62" height="28" rx="5" fill="#ddd6fe" />
        <polygon points="69,56 81,41 90,51 96,44 107,56" fill="#ffffff" opacity="0.9" />
        <circle cx="111" cy="40" r="4" fill="#ffffff" opacity="0.9" />
        <rect x="64" y="64" width="62" height="4" rx="2" fill="#e5e7eb" />
        <rect x="64" y="71" width="44" height="4" rx="2" fill="#e5e7eb" />
        <rect x="64" y="80" width="62" height="10" rx="5" fill="#7c3aed" />
        <rect x="84" y="83.5" width="22" height="3" rx="1.5" fill="#ffffff" opacity="0.55" />
      </g>

      <!-- Component card, colour styles, and the slot the next one drops into. -->
      <g :style="CARD_SHADOW">
        <rect x="142" y="22" width="76" height="24" rx="6" fill="#ffffff" />
        <rect x="148" y="27" width="14" height="14" rx="4" :fill="`url(#${figId})`" />
        <rect x="167" y="29" width="44" height="4" rx="2" fill="#e5e7eb" />
        <rect x="167" y="37" width="30" height="4" rx="2" fill="#e5e7eb" />

        <rect x="142" y="54" width="76" height="20" rx="8" fill="#ffffff" />
        <circle cx="154" cy="64" r="6" fill="#7c3aed" />
        <circle cx="170" cy="64" r="6" fill="#0ea5e9" />
        <circle cx="186" cy="64" r="6" fill="#f24e1e" />
        <circle cx="202" cy="64" r="6" fill="#10b981" />

        <rect x="150" y="80" width="60" height="22" rx="6" fill="none" stroke="#c4b5fd" stroke-width="1.4" stroke-dasharray="5 4" />
        <g stroke="#a78bfa" stroke-width="1.6" stroke-linecap="round">
          <line x1="176" y1="91" x2="184" y2="91" />
          <line x1="180" y1="87" x2="180" y2="95" />
        </g>
      </g>
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
      <!-- The poster is the server's frame at one second, so the tile costs one JPEG instead of a media fetch. -->
      <img v-if="src && !failed" :src="src" alt="" loading="lazy" decoding="async" class="absolute inset-0 h-full w-full object-cover" @error="failed = true" />
      <span class="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-[#1e1b4b]">
        <Play :size="20" fill="currentColor" :stroke-width="0" class="ml-0.5" />
      </span>
      <span
        v-if="duration"
        class="absolute bottom-2 right-2 rounded-sm px-1.5 py-0.5 text-12 font-medium leading-none text-white"
        style="background: rgba(0, 0, 0, 0.65)"
        >{{ duration }}</span>
    </div>
  </div>
</template>
