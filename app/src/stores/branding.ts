import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import { noBranding, type Branding } from '@/data/types';

/**
 * What the operator has branded this installation with, read once at start-up.
 *
 * Everything is optional and everything falls back to filex's own: an unbranded install answers with empty
 * strings, and a server that does not answer at all leaves the app exactly as it ships. Branding is decoration —
 * failing to load it must never stop the app from opening.
 */
export const useBrandingStore = defineStore('branding', () => {
  const brand = ref<Branding>(noBranding());

  /** The operator's name, or filex's own. `app.name` is not translated, so reading it here needs no locale. */
  const name = computed(() => brand.value.name);
  const logoUrl = computed(() => brand.value.logoUrl);

  async function load() {
    brand.value = await repository.branding().catch(() => noBranding());
    applyAccent(brand.value.accent);
  }

  return { brand, name, logoUrl, load };
});

/**
 * The accent, over the five primary tokens.
 *
 * The server derives three of them for its public pages — the colour itself, a hover at 85% and a 14% wash — and
 * this mirrors that rule so an install looks the same on both surfaces. Ring and tint have no server-side
 * counterpart and are washes of the same colour, chosen to sit either side of soft.
 *
 * Four of the five are translucent, which is what makes one hex enough for both themes: a wash of the accent over
 * a light page reads light, and the same wash over a dark one reads dark. Only the hover has to be opaque, so it
 * goes through `light-dark()` — darker against a light page, lighter against a dark one — the way the defaults in
 * tokens.css already do.
 */
function applyAccent(accent: string) {
  const rgb = parseHex(accent);
  if (!rgb) return;
  const [r, g, b] = rgb;
  const style = document.documentElement.style;
  style.setProperty('--c-primary', accent);
  style.setProperty('--c-primary-hover', `light-dark(${scale(rgb, 0.85)}, ${scale(rgb, 1.18)})`);
  style.setProperty('--c-primary-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
  style.setProperty('--c-primary-ring', `rgba(${r}, ${g}, ${b}, 0.45)`);
  style.setProperty('--c-primary-tint', `rgba(${r}, ${g}, ${b}, 0.07)`);
}

/** `#rgb` / `#rrggbb` to channels. The server gates the format already; this is what reads it, not a second gate. */
function parseHex(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
}

/** The same channel multiply the server's `brandingDarken` does, clamped so a factor above 1 lightens instead. */
function scale([r, g, b]: [number, number, number], factor: number): string {
  const channel = (value: number) => Math.min(255, Math.round(value * factor));
  return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
}
