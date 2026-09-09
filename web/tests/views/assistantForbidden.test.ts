// What a TENANT admin sees on the assistant page.
//
// The model provider is one for the whole instance and only the supertenant
// administrator may read or change it; everybody else gets 403 from
// `GET /api/admin/assistant/provider`. The view already computed that, and the
// template never read it: the tenant admin was shown an empty, editable form
// full of defaults, with Test and Save enabled, and every press answered 403.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import Assistant from '@/views/Assistant.vue';
import { AssistantApi } from '@/api/assistant';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

vi.mock('@/api/assistant', async (original) => {
  const actual = await original<typeof import('@/api/assistant')>();
  return {
    ...actual,
    AssistantApi: {
      getProvider: vi.fn(),
      listSessions: vi.fn(async () => []),
      updateProvider: vi.fn(),
      test: vi.fn(),
      deleteSession: vi.fn(),
    },
  };
});

const provider = {
  enabled: false,
  provider: 'openai',
  base_url: '',
  endpoint: 'https://api.openai.com/v1',
  model: '',
  turns_per_minute: 20,
  has_key: false,
  ready: false,
  problem: '',
  providers: ['openai', 'anthropic'],
};

async function mountPage(locale = 'en') {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(Assistant, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

describe('Assistant view for an account that may not manage the provider', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(AssistantApi.listSessions).mockResolvedValue([]);
  });

  it('says the provider is the platform operator’s instead of offering a dead form', async () => {
    vi.mocked(AssistantApi.getProvider).mockRejectedValue({ response: { status: 403 } });
    const w = await mountPage();

    expect(w.find('[data-testid="assistant-forbidden"]').exists()).toBe(true);
    expect(w.text()).toContain(en.assistant.supertenantOnly);
    // No form, so no button that could only answer 403.
    expect(w.text()).not.toContain(en.assistant.fields.model);
    expect(w.findAll('input')).toHaveLength(0);
  });

  it('says it in Turkish too', async () => {
    vi.mocked(AssistantApi.getProvider).mockRejectedValue({ response: { status: 403 } });
    const w = await mountPage('tr');
    expect(w.text()).toContain(tr.assistant.supertenantOnly);
  });

  it('still shows the form to an account the server answers', async () => {
    vi.mocked(AssistantApi.getProvider).mockResolvedValue(provider);
    const w = await mountPage();

    expect(w.find('[data-testid="assistant-forbidden"]').exists()).toBe(false);
    expect(w.text()).toContain(en.assistant.fields.model);
  });
});
