import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, request } from './client';

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('http client', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * A 401 is the caller's to handle. It used to be broadcast as a "session expired" event that nothing listened
   * for, and that could not have been listened for safely: a wrong current password in Settings → Security is a
   * 401 too, so a shell acting on it would have signed the person out from inside the password form.
   */
  it('raises a 401 without announcing it to the window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(401, { error: 'wrong password' })));
    const heard: string[] = [];
    const listener = (event: Event) => heard.push(event.type);
    // Nothing else in the app dispatches on window during a request, so any event here is one this raised.
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event) => (listener(event), true));

    await expect(request('/api/auth/password', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 401,
      body: { error: 'wrong password' },
    });
    expect(heard).toEqual([]);
    spy.mockRestore();
  });

  it('carries the server’s own body on the error, which is what the assistant reads a 429 from', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(429, { error: 'too many turns', code: 'rate_limited' })));
    const error = await request('/api/assistant/turn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).body).toEqual({ error: 'too many turns', code: 'rate_limited' });
  });
});
