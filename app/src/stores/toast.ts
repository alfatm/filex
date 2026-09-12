import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  text: string;
  /** Optional action button ("Undo"); running it dismisses the toast. */
  action?: { label: string; run: () => void };
}

export const TOAST_MS = 4000;
/** A toast that offers an action stays longer so the user can reach it. */
export const TOAST_ACTION_MS = 8000;

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);
  let seq = 0;
  /** Per toast: the running timer and the time left when paused (hover / focus). */
  const timers = new Map<number, { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number }>();

  function dismiss(id: number) {
    const timer = timers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.delete(id);
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function schedule(id: number, ms: number) {
    timers.set(id, { handle: setTimeout(() => dismiss(id), ms), remaining: ms, startedAt: Date.now() });
  }

  function push(text: string, action?: Toast['action']) {
    const id = ++seq;
    toasts.value.push({ id, text, action });
    schedule(id, action ? TOAST_ACTION_MS : TOAST_MS);
    return id;
  }

  function pause(id: number) {
    const timer = timers.get(id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
  }

  function resume(id: number) {
    const timer = timers.get(id);
    if (!timer || timer.handle) return;
    schedule(id, timer.remaining);
  }

  /** Drops every toast that offers an action (pending Undo after the trash was emptied or items deleted forever). */
  function dismissActions() {
    for (const t of toasts.value.filter((t) => t.action)) dismiss(t.id);
  }

  return { toasts, push, dismiss, pause, resume, dismissActions };
});
