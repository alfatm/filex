import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { useCapabilitiesStore } from './capabilities';

describe('the capability snapshot', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  // The rejection used to leave the start-up call — every menu then said "Not available on this server" for the
  // rest of the session, for a server that had simply not answered.
  it('records a snapshot that never arrived instead of throwing into nothing', async () => {
    const spy = vi.spyOn(repository, 'capabilities').mockRejectedValue(new Error('offline'));
    const store = useCapabilitiesStore();
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.failed).toBe(true);
    expect(store.loaded).toBe(false);
    expect(store.can.assistant).toBe(false);

    // And asking again is what the failure being remembered is for.
    spy.mockRestore();
    await store.load();
    expect(store.failed).toBe(false);
    expect(store.loaded).toBe(true);
  });
});
