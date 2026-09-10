import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, request, setUnauthorizedHandler } from './client';

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('http client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  /** A 401 is still the caller's to handle; reporting it is what tells the shell the cookie is gone. */
  it('raises a 401 and reports it as a lost session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(401, { error: 'unauthorized' })));
    const lost = vi.fn();
    setUnauthorizedHandler(lost);

    await expect(request('/api/files/manager', { query: { q: 'list' } })).rejects.toMatchObject({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason the report has to be opt-out: a wrong current password in Settings → Security is a 401 too, and a
   * shell acting on it would offer to sign the person in again from inside the password form.
   */
  it('keeps quiet about a 401 the caller expects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(401, { error: 'wrong password' })));
    const lost = vi.fn();
    setUnauthorizedHandler(lost);

    await expect(request('/api/auth/password', { method: 'POST', body: {}, expectUnauthorized: true })).rejects.toMatchObject({ status: 401 });
    expect(lost).not.toHaveBeenCalled();
  });

  it('carries the server’s own body on the error, which is what the assistant reads a 429 from', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(429, { error: 'too many turns', code: 'rate_limited' })));
    const error = await request('/api/assistant/turn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).body).toEqual({ error: 'too many turns', code: 'rate_limited' });
  });
});
