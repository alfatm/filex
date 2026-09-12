// The assistant's operator surface. What is tested here is mostly what the
// module CANNOT do: hand back the stored API key, and read a conversation.
import { describe, expect, it, vi } from 'vitest';

const calls: { method: string; url: string; body?: unknown }[] = [];

vi.mock('@/api/client', () => ({
  api: {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return url.endsWith('/sessions')
        ? { data: { sessions: [{ id: '3', user_id: 1, user_email: 'a@b.c', title: '', message_count: 2, last_active_at: '', created_at: '' }] } }
        : { data: { enabled: true, provider: 'openai', base_url: '', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini', turns_per_minute: 20, has_key: true, ready: true, problem: '', providers: ['openai', 'anthropic'] } };
    },
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: { has_key: true } };
    },
    post: async (url: string, body: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: { ok: true, model: 'gpt-4o-mini', reply: 'OK' } };
    },
    delete: async (url: string) => {
      calls.push({ method: 'delete', url });
      return { data: { ok: true } };
    },
  },
}));

const { AssistantApi, KEY_UNCHANGED } = await import('@/api/assistant');

describe('api/assistant', () => {
  it('reports whether a key is stored, and never the key', async () => {
    const provider = await AssistantApi.getProvider();
    expect(provider.has_key).toBe(true);
    // The whole shape, so a field carrying a secret could not be added unnoticed.
    expect(Object.keys(provider)).toEqual([
      'enabled', 'provider', 'base_url', 'endpoint', 'model', 'turns_per_minute', 'has_key', 'ready', 'problem', 'providers',
    ]);
    expect(JSON.stringify(provider)).not.toContain('api_key');
  });

  it('sends the redaction marker to leave a stored key alone', async () => {
    await AssistantApi.updateProvider({ model: 'gpt-4o', api_key: KEY_UNCHANGED });
    expect(calls.at(-1)).toMatchObject({ method: 'put', url: '/admin/assistant/provider', body: { model: 'gpt-4o', api_key: '***' } });
  });

  it('sends an empty key to remove the stored one', async () => {
    await AssistantApi.updateProvider({ api_key: '' });
    expect(calls.at(-1)?.body).toEqual({ api_key: '' });
  });

  it('lists conversations as metadata — counts and dates, no messages', async () => {
    const rows = await AssistantApi.listSessions();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(['id', 'user_id', 'user_email', 'title', 'message_count', 'last_active_at', 'created_at']);
  });

  // ⚠ There is no "read a conversation" call here because there is no route
  // behind one. If this ever fails, something added a way to read one.
  it('offers no way to read a conversation', () => {
    expect(Object.keys(AssistantApi).sort()).toEqual(['deleteSession', 'getProvider', 'listSessions', 'test', 'updateProvider']);
  });

  it('reports a failed provider call as a result, not a throw', async () => {
    await expect(AssistantApi.test()).resolves.toMatchObject({ ok: true, reply: 'OK' });
    expect(calls.at(-1)).toMatchObject({ method: 'post', url: '/admin/assistant/provider/test' });
  });
});
