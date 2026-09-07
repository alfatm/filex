import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_ACTION_MS, TOAST_MS, useToastStore } from './toast';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses; toasts with an action stay longer', () => {
    const toast = useToastStore();
    toast.push('plain');
    toast.push('undoable', { label: 'Undo', run: () => {} });
    vi.advanceTimersByTime(TOAST_MS);
    expect(toast.toasts.map((t) => t.text)).toEqual(['undoable']);
    vi.advanceTimersByTime(TOAST_ACTION_MS - TOAST_MS);
    expect(toast.toasts).toEqual([]);
  });

  it('pause holds the timer and resume continues with the remaining time', () => {
    const toast = useToastStore();
    const id = toast.push('hover me');
    vi.advanceTimersByTime(TOAST_MS / 2);
    toast.pause(id);
    vi.advanceTimersByTime(TOAST_MS * 2);
    expect(toast.toasts).toHaveLength(1);
    toast.resume(id);
    vi.advanceTimersByTime(TOAST_MS / 2 - 1);
    expect(toast.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toast.toasts).toEqual([]);
  });

  it('dismissActions drops only the toasts that offer an action', () => {
    const toast = useToastStore();
    toast.push('plain');
    toast.push('undoable', { label: 'Undo', run: () => {} });
    toast.dismissActions();
    expect(toast.toasts.map((t) => t.text)).toEqual(['plain']);
  });
});
