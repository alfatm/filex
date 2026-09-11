// The admin Shares page: which links it asks for, and how it labels a dead one.
//
// Closing a link from the end-user app is a SOFT revoke — the row stays as the
// audit trail — so the admin table used to keep showing it with nothing but an
// expiry in the past to go on. The user who pressed "Remove" saw it disappear;
// the operator saw an ordinary-looking row that would not die. Both facts below
// exist for that: the list defaults to links that still work, and a revoked row
// says so.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import Shares from '@/views/Shares.vue';
import { SharesApi } from '@/api/shares';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

vi.mock('@/api/shares', async (original) => {
  const actual = await original<typeof import('@/api/shares')>();
  return {
    ...actual,
    SharesApi: { list: vi.fn(), revoke: vi.fn(), remove: vi.fn() },
  };
});

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 86_400_000).toISOString();

function row(share: Record<string, unknown>) {
  return { share, creator_email: 'ada@example.com', node_path: '/docs/plan.pdf', storage_name: 'home' };
}

// Only the row badges — the page also carries a "Share revoked" toast string
// in a hidden modal, which a whole-page text match would trip over.
function states(w: ReturnType<typeof mount>): string[] {
  return w.findAll('[data-testid="share-state"]').map((b) => b.text());
}

async function mountPage() {
  const i18n = createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(Shares, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

describe('Shares (admin)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(SharesApi.list).mockResolvedValue({ items: [], total: 0, page: 1, page_size: 50 });
  });

  it('asks only for links that still work', async () => {
    await mountPage();
    expect(SharesApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ active_only: true, page: 1, page_size: 50 }),
    );
  });

  it('drops the active filter when the operator asks for every link', async () => {
    const w = await mountPage();
    await w.find('select').setValue('all');
    await flushPromises();
    expect(vi.mocked(SharesApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ active_only: undefined });
  });

  it('marks a revoked link as revoked, not merely expired', async () => {
    vi.mocked(SharesApi.list).mockResolvedValue({
      // A revoke pulls expires_at back to now as well, so the row carries both
      // timestamps — the page must report the reason, not the side effect.
      items: [row({ id: 1, token: 'a'.repeat(32), expires_at: past, revoked_at: past })] as never,
      total: 1,
      page: 1,
      page_size: 50,
    });
    const w = await mountPage();
    expect(states(w)).toEqual([en.shares.revoked]);
  });

  it('marks a lapsed link as expired', async () => {
    vi.mocked(SharesApi.list).mockResolvedValue({
      items: [row({ id: 2, token: 'b'.repeat(32), expires_at: past })] as never,
      total: 1,
      page: 1,
      page_size: 50,
    });
    const w = await mountPage();
    expect(states(w)).toEqual([en.shares.expired]);
  });

  it('leaves a live link unlabelled', async () => {
    vi.mocked(SharesApi.list).mockResolvedValue({
      items: [row({ id: 3, token: 'c'.repeat(32), expires_at: future })] as never,
      total: 1,
      page: 1,
      page_size: 50,
    });
    const w = await mountPage();
    expect(states(w)).toEqual([]);
  });
});
