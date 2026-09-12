<script lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { Check } from 'lucide-vue-next';

export interface FloatingMenuEntry {
  id: string;
  label: string;
  icon?: Component;
  danger?: boolean;
  /** Set on the entries of a single-choice menu: renders a check column and makes them `menuitemradio`. */
  checked?: boolean;
  disabled?: boolean;
  /** Tooltip for disabled entries ("Coming soon"). */
  hint?: string;
  dividerBefore?: boolean;
}

const ANCHOR_GAP = 6;

/** Viewport point for a menu of `width` right below `anchor`, its right edge flush with the anchor's. */
export function anchorBelow(anchor: HTMLElement, width: number): { x: number; y: number } {
  const rect = anchor.getBoundingClientRect();
  return { x: Math.max(0, rect.right - width), y: rect.bottom + ANCHOR_GAP };
}
</script>

<script setup lang="ts">
/**
 * Menu at a fixed viewport point (spec §7: radius 12, shadow-menu, padding 6, items h 38 / 15px / 18px icon).
 * Not tied to a trigger button, so it serves the ⋮ buttons, right-click and the sidebar's New button alike.
 * Focus goes back to the element that had it when the menu opened (the trigger) once the menu unmounts.
 */
const props = withDefaults(
  defineProps<{
    items: FloatingMenuEntry[];
    x: number;
    y: number;
    width?: number;
    label: string;
    /** The element the menu was placed against, when there is one; a right-click at a point has none. */
    anchor?: HTMLElement | null;
  }>(),
  { width: 232, anchor: null },
);
const emit = defineEmits<{ select: [id: string]; close: [] }>();

const root = ref<HTMLElement>();
const left = ref(props.x);
const top = ref(props.y);
const returnTo = document.activeElement as HTMLElement | null;

const MARGIN = 8;

/** Keeps the menu inside the viewport: overflowing menus flip left / up. */
async function place() {
  left.value = props.x;
  top.value = props.y;
  await nextTick();
  const el = root.value;
  if (!el) return;
  if (props.x + el.offsetWidth > window.innerWidth - MARGIN) left.value = Math.max(MARGIN, props.x - el.offsetWidth);
  if (props.y + el.offsetHeight > window.innerHeight - MARGIN) top.value = Math.max(MARGIN, props.y - el.offsetHeight);
}

// Disabled entries stay in the arrow cycle so their hint is reachable; they just do not activate.
function buttons(): HTMLButtonElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLButtonElement>('button') ?? []);
}

function step(delta: 1 | -1) {
  const list = buttons();
  if (!list.length) return;
  const index = list.indexOf(document.activeElement as HTMLButtonElement);
  list[(index + delta + list.length) % list.length].focus();
}

function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      emit('close');
      break;
    case 'Tab':
      // Not prevented: focus returns to the trigger on unmount, and the Tab then moves on from there.
      emit('close');
      break;
    case 'ArrowDown':
      event.preventDefault();
      step(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      step(-1);
      break;
  }
}

function onPointerDown(event: Event) {
  if (!root.value?.contains(event.target as globalThis.Node)) emit('close');
}

function onSelect(item: FloatingMenuEntry) {
  if (!item.disabled) emit('select', item.id);
}

const close = () => emit('close');

/** Where the anchor sits right now, or null when the menu has none to follow. */
function anchorAt(): { left: number; top: number } | null {
  const box = props.anchor?.getBoundingClientRect();
  return box ? { left: box.left, top: box.top } : null;
}

let placedAgainst: { left: number; top: number } | null = null;

/**
 * A scroll closes the menu only once it has actually taken the anchor somewhere else.
 *
 * It used to close on ANY scroll caught on the way down, which included the scroll the opening itself causes:
 * pressing a row's ⋮ focuses that button, and below roughly 1500px the browser scrolls the listing's horizontally
 * scrollable wrapper to reveal it. That event lands a few milliseconds after the menu mounted — so on a narrow
 * window the menu opened and vanished. The anchor is measured after that scroll, so comparing against it tells the
 * two apart. A menu opened at a bare point (right-click) has no anchor and still closes on any scroll.
 */
function onScroll() {
  if (!props.anchor) return close();
  const now = anchorAt();
  if (!now || !placedAgainst || now.left !== placedAgainst.left || now.top !== placedAgainst.top) close();
}

onMounted(async () => {
  await place();
  buttons().find((b) => b.getAttribute('aria-disabled') !== 'true')?.focus();
  // After the focus, so that whatever the browser scrolls to reveal something is already part of the reading.
  placedAgainst = anchorAt();
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('mousedown', onPointerDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', onScroll, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('mousedown', onPointerDown, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', onScroll, true);
  // Only when focus is still ours (or lost to <body>); a caller that already moved it keeps its choice.
  const active = document.activeElement;
  if ((!active || active === document.body || root.value?.contains(active)) && returnTo?.isConnected) returnTo.focus();
});
watch(() => [props.x, props.y], place);
</script>

<!--
  Rendered at the body, not where it was opened.

  `position: fixed` escapes an ancestor's `overflow`, but NOT an ancestor that is a containing block for fixed
  descendants — a `mask-image`, a `transform`, a `filter`. Measured: below `xl` the filter chips sit in a masked
  side-scroller (`.chips-scroller`), so every chip menu was clipped to the strip of the chips themselves and
  painted nothing at all, while staying in the DOM and "visible" to a test. A menu placed in viewport coordinates
  belongs in the viewport's own stacking context.

  ⚠ `z-40`, level with the modals and panels rather than above them: a menu opened from inside one is now its
  SIBLING rather than its descendant, and at the body it comes later in the document, which is what puts it on
  top. The z-50 surfaces (the drawer, the toasts, the session modal) stay above, and none of them opens a menu.
-->
<template>
  <Teleport to="body">
    <div
      ref="root"
      role="menu"
      :aria-label="label"
      class="scroll-thin fixed z-40 max-h-[calc(100dvh-16px)] overflow-y-auto rounded-lg bg-bg p-1.5 shadow-menu"
      :style="{ left: `${left}px`, top: `${top}px`, width: `${width}px` }"
    >
      <template v-for="item in items" :key="item.id">
        <div v-if="item.dividerBefore" class="my-1.5 h-px bg-border" />
        <button
          type="button"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemradio'"
          :aria-checked="item.checked"
          :aria-disabled="item.disabled || undefined"
          :title="item.disabled ? item.hint : undefined"
          class="flex h-control-sm w-full items-center gap-2 rounded px-2.5 text-12 leading-none hover:bg-bg-muted focus:outline-none focus-visible:bg-bg-muted"
          :class="item.disabled ? 'cursor-default text-text-3' : item.danger ? 'text-danger' : 'text-text'"
          @click="onSelect(item)"
        >
          <!-- The column is reserved for every entry of a single-choice menu, so the labels stay on one line. -->
          <span v-if="item.checked !== undefined" class="flex w-4 shrink-0 justify-center text-primary">
            <Check v-if="item.checked" :size="14" :stroke-width="2.5" />
          </span>
          <component :is="item.icon" v-if="item.icon" :size="16" class="shrink-0" />
          <span>{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
