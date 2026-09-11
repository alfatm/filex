import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { noCapabilities, ROLE_PERMISSIONS } from '@/data/types';
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

    // "We do not know" is not "the role may do nothing". A permission is a rule about what is WITHHELD, and a
    // failed snapshot withholds nothing — read as "none", one proxy 502 at start-up used to disable restore,
    // share, rename, starring and download with "Your role may not do this", which no administrator had said.
    for (const permission of ROLE_PERMISSIONS) expect(store.allows(permission)).toBe(true);
    // While every capability the SERVER answers for stays off, so nothing it would reject is offered.
    const driver = { ...store.can, allowed: undefined };
    expect(Object.values(driver).filter((v) => typeof v === 'boolean')).not.toContain(true);

    // And asking again is what the failure being remembered is for.
    spy.mockResolvedValue({ ...noCapabilities(), assistant: true });
    await store.load();
    expect(store.can.assistant).toBe(true);
    expect(store.failed).toBe(false);
    expect(store.loaded).toBe(true);
  });
});
