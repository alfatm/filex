<script setup lang="ts">
import { ref, useId } from 'vue';
import { Play } from 'lucide-vue-next';
import type { ThumbnailKind } from '@/data/types';

/** `src` is the server's cached preview (Node.thumbUrl); without it, or once it fails to load, the placeholder paints. */
defineProps<{ kind: ThumbnailKind; duration?: string; src?: string }>();
// Several thumbnails render on one page; an SVG gradient id must be unique in the document.
const skyId = useId();
const figId = useId();
const sheetId = useId();
const CARD_SHADOW = 'filter: drop-shadow(0 1.5px 2px rgba(76, 29, 149, 0.12))';
// Spreadsheet placeholder: x of the bars in the three wide columns, y of the five data rows.
const SHEET_COLS = [68, 128, 187];
const SHEET_ROWS = [27, 42, 57, 72, 87];
// Generic placeholder: the dot grid's columns and rows, and the page itself. The page is the one thing here that
// no token pair fits — it is paper on a near-white ground in light, and a raised card lifted off a near-black one
// in dark, where `--c-bg` would be the ground it has to stand out from — so it carries its own pair.
const DOT_COLS = [172, 184, 196, 208];
const DOT_ROWS = [12, 24, 36, 48];
const PAGE_FILL = 'light-dark(#ffffff, #3f4650)';
const PAGE_LINE = 'light-dark(#9ca3af, #c9ccd3)';
const PAGE_SHADOW = 'drop-shadow(0 2px 3px light-dark(rgba(17, 24, 39, 0.1), rgba(0, 0, 0, 0.45)))';
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

    <!-- The only placeholder made of real text. Hidden from assistive technology like every other one here: the
         thumbnail comes before the name in the card, so this decorative source line was being read out as the
         start of the card's accessible name, ahead of the file it stands for. -->
    <div v-else-if="kind === 'code'" aria-hidden="true" class="h-full w-full bg-[#1e293b] px-4 py-4 font-mono text-[11px] leading-[20px]">
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

    <!-- A sheet of data: the header band, the rows under it running past the bottom edge, and the chart it is read for. -->
    <svg v-else-if="kind === 'spreadsheet'" viewBox="0 0 236 108" class="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient :id="sheetId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0" />
          <stop offset="1" stop-color="#ffffff" />
        </linearGradient>
      </defs>
      <rect width="236" height="108" fill="#f0fdf4" />

      <rect x="16" y="12" width="220" height="96" fill="#ffffff" />
      <rect x="16" y="12" width="220" height="15" fill="#dcfce7" />
      <g stroke="#e5e7eb" stroke-width="1">
        <line v-for="i in 6" :key="`sh${i}`" x1="16" :y1="12 + i * 15" x2="236" :y2="12 + i * 15" />
        <line v-for="x in SHEET_COLS" :key="`sv${x}`" :x1="x - 10" y1="12" :x2="x - 10" y2="108" />
        <line x1="16" y1="12" x2="16" y2="108" />
      </g>
      <g fill="#22c55e">
        <rect v-for="x in SHEET_COLS" :key="`sx${x}`" :x="x" y="17" width="30" height="5" rx="2.5" />
      </g>
      <template v-for="y in SHEET_ROWS" :key="`sr${y}`">
        <rect x="22" :y="y + 5" width="25" height="5" rx="2.5" fill="#bbf7d0" />
        <rect v-for="x in SHEET_COLS" :key="`sc${x}-${y}`" :x="x" :y="y + 5" width="24" height="5" rx="2.5" fill="#e5e7eb" />
      </template>
      <rect y="55" width="236" height="53" :fill="`url(#${sheetId})`" />

      <g style="filter: drop-shadow(0 2px 3px rgba(22, 101, 52, 0.16))">
        <rect x="188" y="64" width="38" height="38" rx="11" fill="#ffffff" />
        <rect x="194" y="84" width="6" height="10" rx="2" fill="#86efac" />
        <rect x="204" y="79" width="6" height="15" rx="2" fill="#4ade80" />
        <rect x="214" y="72" width="6" height="22" rx="2" fill="#16a34a" />
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

    <!-- Every other file: no art of its own and no preview from the server. A page with its corner turned on the
         same soft ground, so the tile reads as "nothing to show" rather than as an image that failed to load. -->
    <svg v-else viewBox="0 0 236 108" class="h-full w-full" aria-hidden="true">
      <rect width="236" height="108" class="fill-bg" />
      <g class="fill-border-soft">
        <circle cx="74" cy="32" r="46" />
        <circle cx="154" cy="88" r="42" />
      </g>
      <g class="fill-border">
        <template v-for="x in DOT_COLS" :key="`gc${x}`">
          <circle v-for="y in DOT_ROWS" :key="`gd${x}-${y}`" :cx="x" :cy="y" r="2" />
        </template>
      </g>
      <g
        transform="translate(93 22) scale(1.14)"
        :style="{ filter: PAGE_SHADOW, fill: PAGE_FILL, stroke: PAGE_LINE }"
        stroke-width="2.4"
        stroke-linejoin="round"
      >
        <rect x="1" y="1" width="42" height="54" rx="6" />
        <!-- The turned corner, painted over the page's own top-right corner. -->
        <path d="M29 1h8a6 6 0 0 1 6 6v8Z" :style="{ fill: PAGE_LINE }" />
      </g>
    </svg>
  </div>
</template>
