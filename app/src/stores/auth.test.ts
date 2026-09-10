import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { INVALID_CREDENTIALS } from '@/data/repository';
import { resetMock } from '@/data/mock';
import { useAuthStore } from './auth';

describe('auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetMock();
  });
  afterEach(() => vi.restoreAllMocks());
  // The store says so in the console when it declares a session dead; the assertions below are what read it here.
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));

  it('asks the server once and remembers the answer', async () => {
    const asked = vi.spyOn(repository, 'session');
    const auth = useAuthStore();
    expect(await auth.check()).toBe(true);
    expect(await auth.check()).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(auth.user?.email).toBe('demo@filex.local');
  });

  /*
   * The distinction the whole guard rests on: a server that cannot be reached must not read as a sign-out. Left
   * unchecked, the next navigation asks again — and nobody is thrown at the form with their work behind it.
   */
  it('treats an unreachable server as unknown, not as signed out', async () => {
    vi.spyOn(repository, 'session').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const auth = useAuthStore();
    expect(await auth.check()).toBe(false);
    expect(auth.checked).toBe(false);
  });

  it('reports no session as a signed-out answer that stands', async () => {
    await repository.signOut();
    const auth = useAuthStore();
    expect(await auth.check()).toBe(false);
    expect(auth.checked).toBe(true);
  });

  it('takes the demo credentials and refuses everything else', async () => {
    await repository.signOut();
    const auth = useAuthStore();
    await expect(auth.signIn({ identifier: 'demo@filex.local', password: 'nope' })).rejects.toThrow(INVALID_CREDENTIALS);
    expect(auth.signedIn).toBe(false);
    await auth.signIn({ identifier: 'demo@filex.local', password: 'demo' });
    expect(auth.signedIn).toBe(true);
    expect(auth.checked).toBe(true);
  });

  /*
   * The 401 that started this: filex answers one for a node's permissions or its share state while the session is
   * alive, so the shell asks `/api/auth/me` before saying anything, and says nothing when the answer is a user.
   */
  it('does not cry session over a 401 the server gives a signed-in account', async () => {
    const auth = useAuthStore();
    await auth.check();
    const asked = vi.spyOn(repository, 'session');
    auth.noteUnauthorized();
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    expect(auth.expired).toBe(false);
  });

  /*
   * And once when it is real: an expired cookie fails every request the screen makes, and the person is told
   * about their session — not about each of the eight calls that noticed it.
   */
  it('announces a lost session once, after asking the server', async () => {
    const auth = useAuthStore();
    await auth.check();
    const asked = vi.spyOn(repository, 'session').mockResolvedValue(null);
    auth.noteUnauthorized();
    await vi.waitFor(() => expect(auth.expired).toBe(true));
    auth.dismissExpired();
    auth.noteUnauthorized();
    await Promise.resolve();
    expect(auth.expired).toBe(false);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  /*
   * The one that put the prompt on screen after a perfectly good sign-in: the form's own requests are refused to a
   * visitor, so anything raised before the session existed is dropped when one does.
   */
  it('forgets a sign-out raised before this session', async () => {
    vi.spyOn(repository, 'session').mockResolvedValue(null);
    await repository.signOut();
    const auth = useAuthStore();
    auth.noteUnauthorized();
    await vi.waitFor(() => expect(auth.expired).toBe(true));

    vi.restoreAllMocks();
    await auth.signIn({ identifier: 'demo@filex.local', password: 'demo' });
    expect(auth.expired).toBe(false);
    // And the new session may raise it in its turn.
    vi.spyOn(repository, 'session').mockResolvedValue(null);
    auth.noteUnauthorized();
    await vi.waitFor(() => expect(auth.expired).toBe(true));
  });

  /** A burst of failures is one session; the probe is not repeated per failed request. */
  it('asks once for a burst of 401s', async () => {
    const auth = useAuthStore();
    await auth.check();
    const asked = vi.spyOn(repository, 'session').mockResolvedValue(null);
    auth.noteUnauthorized();
    auth.noteUnauthorized();
    auth.noteUnauthorized();
    await vi.waitFor(() => expect(auth.expired).toBe(true));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  /** Signing in again resumes where they were, rather than dumping them on Home. */
  it('carries the current address to the sign-in form', () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, pathname: '/files/demo/photos', search: '?view=grid', assign } as unknown as Location);
    useAuthStore().reauth();
    expect(assign).toHaveBeenCalledWith('/login?redirect=%2Ffiles%2Fdemo%2Fphotos%3Fview%3Dgrid');
  });

  /*
   * A reload and not a route change: every store still holds the previous account's listings, uploads and
   * conversations, and a signed-out shell that keeps showing them is both a leak and a screen of actions the
   * server now answers 401 to.
   */
  it('reloads onto the sign-in screen rather than routing to it', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
    const auth = useAuthStore();
    await auth.check();
    await auth.signOut();
    expect(auth.signedIn).toBe(false);
    expect(assign).toHaveBeenCalledWith('/login');
    expect(await repository.session()).toBeNull();
  });
});
