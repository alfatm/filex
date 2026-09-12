// The self-service TOTP calls. Disabling has to carry BOTH proofs: the server
// checks the password before it looks at the code and answers 401 "password
// incorrect" to a body without one, so a `{code}`-only request could never work.
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const calls: { method: string; url: string; body?: unknown }[] = [];

vi.mock('@/api/client', () => ({
  api: {
    post: async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: { ok: true } };
    },
  },
}));

const { AuthApi } = await import('@/api/auth');

describe('api/auth TOTP', () => {
  it('sends the password and the code together when disabling the second factor', async () => {
    await AuthApi.disableTotp('hunter22', '123456');
    expect(calls.at(-1)).toEqual({ method: 'post', url: '/auth/totp/disable', body: { password: 'hunter22', code: '123456' } });
  });

  it('verifies with the code alone', async () => {
    await AuthApi.verifyTotp('654321');
    expect(calls.at(-1)).toEqual({ method: 'post', url: '/auth/totp/verify', body: { code: '654321' } });
  });
});
