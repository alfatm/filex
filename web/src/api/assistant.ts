// The AI assistant's operator surface.
//
//   GET  /api/admin/assistant/provider        what model this installation talks to
//   PUT  /api/admin/assistant/provider        change it
//   POST /api/admin/assistant/provider/test   ask it one short question
//   GET  /api/admin/assistant/sessions        every account's conversations, as METADATA
//   DEL  /api/admin/assistant/sessions/{id}   clear one
//
// ⚠ Two things this module deliberately cannot do, because the backend has no
// route for either: read the stored API key, and read a conversation. The key
// is write-only (`has_key` is all that comes back, and the redaction marker
// means "leave it alone"), and the sessions route answers with counts and
// dates — an administrator may see that an account holds forty conversations
// and delete one, and may never read a line. See docs/ASSISTANT.md.
import { api } from './client';

/** Sent in place of the key to say "unchanged". Matches `redactedSecret` on the server. */
export const KEY_UNCHANGED = '***';

export interface AssistantProvider {
  enabled: boolean;
  /** The wire protocol, not the vendor: `openai` also covers vLLM, Ollama and any gateway. */
  provider: string;
  base_url: string;
  /** Where questions actually go — the base URL, or the provider's own when it is empty. */
  endpoint: string;
  model: string;
  turns_per_minute: number;
  /** Whether a key is stored. Never the key itself. */
  has_key: boolean;
  /** Whether this installation can answer a question at all. */
  ready: boolean;
  /** Why it cannot, when it cannot. */
  problem: string;
  /** The protocols this server accepts, so the form cannot offer one it would refuse. */
  providers: string[];
}

export interface AssistantProviderPatch {
  enabled?: boolean;
  provider?: string;
  base_url?: string;
  model?: string;
  turns_per_minute?: number;
  /** Plaintext, or KEY_UNCHANGED. An empty string removes the stored key. */
  api_key?: string;
}

/** What one live call to the provider reported. */
export interface AssistantTestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  error?: string;
}

/** One conversation, as much of it as an operator is ever shown. */
export interface AssistantSessionRow {
  id: string;
  user_id: number;
  user_email: string;
  /** Generated under a prompt that forbids naming a file; empty when it has no name yet. */
  title: string;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

export const AssistantApi = {
  async getProvider(): Promise<AssistantProvider> {
    const { data } = await api.get<AssistantProvider>('/admin/assistant/provider');
    return data;
  },

  async updateProvider(patch: AssistantProviderPatch): Promise<AssistantProvider> {
    const { data } = await api.put<AssistantProvider>('/admin/assistant/provider', patch);
    return data;
  },

  /** ⚠ Answers 200 with `ok: false` for a failed call: the failure IS the result. */
  async test(): Promise<AssistantTestResult> {
    const { data } = await api.post<AssistantTestResult>('/admin/assistant/provider/test', {});
    return data;
  },

  async listSessions(): Promise<AssistantSessionRow[]> {
    const { data } = await api.get<{ sessions: AssistantSessionRow[] }>('/admin/assistant/sessions');
    return data.sessions ?? [];
  },

  async deleteSession(id: string): Promise<void> {
    await api.delete(`/admin/assistant/sessions/${id}`);
  },
};
