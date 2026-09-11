// The quotas page: the instance defaults, and the tri-state per-account
// override laid over them.
//
// The tri-state is the whole point and the easiest thing to get wrong: `0` on
// the wire means "inherit the default", `-1` means "unlimited for this
// account", and anything above zero is a limit. A page that sends `0` for
// Unlimited would silently hand the account the default instead — so the
// editor's encoding is asserted here, both directions.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import Quotas from '@/views/Quotas.vue';
import { QuotasApi } from '@/api/quotas';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

vi.mock('@/api/quotas', async (original) => {
  const actual = await original<typeof import('@/api/quotas')>();
  return {
    ...actual,
    QuotasApi: {
      getDefaults: vi.fn(),
      updateDefaults: vi.fn(),
      listUsers: vi.fn(),
      getUser: vi.fn(),
      updateUser: vi.fn(),
      recomputeUser: vi.fn(),
    },
  };
});

const GB = 1_000_000_000;

const defaults = {
  quota_bytes: 10 * GB,
  quota_files: 1000,
  upload_bytes: 5 * GB,
  upload_window_hours: 24,
};

const row = {
  id: 7,
  email: 'ada@example.com',
  display_name: 'Ada Lovelace',
  role: 'user' as const,
  // Storage inherits the default, files are unlimited for this account,
  // uploads carry a 2 GB limit of their own.
  overrides: { quota_bytes: 0, quota_files: -1, quota_upload_bytes: 2 * GB },
  effective: { quota_bytes: 10 * GB, quota_files: 0, upload_bytes: 2 * GB },
  used_bytes: 3 * GB,
  used_files: 42,
  upload_used_bytes: GB,
};

const snapshot = {
  used_bytes: 3 * GB,
  quota_bytes: 0,
  percent_used: 0,
  unlimited: true,
  used_files: 42,
  quota_files: 1000,
  files_unlimited: false,
  upload_used_bytes: GB,
  upload_quota_bytes: 2 * GB,
  upload_window_hours: 24,
  upload_unlimited: false,
  sources: { bytes: 'override', files: 'default', upload: 'override' },
  overrides: { quota_bytes: -1, quota_files: 0, quota_upload_bytes: 2 * GB },
};

async function mountPage(locale = 'en') {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(Quotas, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

describe('Quotas', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(QuotasApi.getDefaults).mockResolvedValue({ ...defaults });
    vi.mocked(QuotasApi.listUsers).mockResolvedValue({
      users: [{ ...row }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    vi.mocked(QuotasApi.getUser).mockResolvedValue({ ...snapshot });
    vi.mocked(QuotasApi.updateDefaults).mockResolvedValue({ ...defaults });
    vi.mocked(QuotasApi.updateUser).mockResolvedValue(undefined);
  });

  it('renders the instance defaults in gigabytes', async () => {
    const w = await mountPage();
    expect((w.find('input[name="defaults-storage"]').element as HTMLInputElement).value).toBe('10');
    expect((w.find('input[name="defaults-files"]').element as HTMLInputElement).value).toBe('1000');
    expect((w.find('input[name="defaults-upload"]').element as HTMLInputElement).value).toBe('5');
    expect((w.find('input[name="defaults-window"]').element as HTMLInputElement).value).toBe('24');
  });

  it('saves the defaults as bytes, not gigabytes', async () => {
    const w = await mountPage();
    await w.find('input[name="defaults-storage"]').setValue('20');
    await w.find('input[name="defaults-window"]').setValue('12');
    await w.find('[data-testid="quotas-defaults"]').trigger('submit');
    await flushPromises();

    expect(QuotasApi.updateDefaults).toHaveBeenCalledWith({
      quota_bytes: 20 * GB,
      quota_files: 1000,
      upload_bytes: 5 * GB,
      upload_window_hours: 12,
    });
  });

  it('labels every limit cell as a default or as this account’s own override', async () => {
    const w = await mountPage();
    expect(w.find('[data-testid="source-bytes"]').text()).toBe(en.quotas.accounts.default);
    expect(w.find('[data-testid="source-files"]').text()).toBe(en.quotas.accounts.override);
    expect(w.find('[data-testid="source-upload"]').text()).toBe(en.quotas.accounts.override);
  });

  it('shows the effective limit, with an unlimited one spelled out', async () => {
    const w = await mountPage();
    const text = w.text();
    // Storage: 3 GB of the inherited 10 GB. Files: unlimited for this account.
    expect(text).toContain('10 GB');
    expect(text).toContain(en.quota.unlimited);
  });

  it('sends -1 for Unlimited and 0 for Inherit default', async () => {
    const w = await mountPage();
    await w.find('[data-testid="edit-row"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="quota-editor"]').exists()).toBe(true);

    // Files start at Unlimited (-1) and storage at Inherit (0); swap them.
    await w.find('select[name="edit-storage-mode"]').setValue('unlimited');
    await w.find('select[name="edit-files-mode"]').setValue('inherit');
    await w.find('[data-testid="quota-editor"]').trigger('submit');
    await flushPromises();

    expect(QuotasApi.updateUser).toHaveBeenCalledWith(7, {
      quota_bytes: -1,
      quota_files: 0,
      // Untouched: the 2 GB override round-trips through the GB input.
      quota_upload_bytes: 2 * GB,
    });
    // The row is re-read from the server rather than patched from the form.
    expect(QuotasApi.getUser).toHaveBeenCalledWith(7);
  });

  // Bytes are the model, GB only a rendering. Rounding the rendering to two
  // decimals used to turn a 2 MB limit into `0` — and `0` here means unlimited.
  it('keeps a sub-gigabyte default when only the upload window is edited', async () => {
    vi.mocked(QuotasApi.getDefaults).mockResolvedValue({ ...defaults, quota_bytes: 2_000_000 });
    const w = await mountPage();
    expect((w.find('input[name="defaults-storage"]').element as HTMLInputElement).value).not.toBe(
      '0',
    );

    await w.find('input[name="defaults-window"]').setValue('12');
    await w.find('[data-testid="quotas-defaults"]').trigger('submit');
    await flushPromises();

    expect(QuotasApi.updateDefaults).toHaveBeenCalledWith({
      quota_bytes: 2_000_000,
      quota_files: 1000,
      upload_bytes: 5 * GB,
      upload_window_hours: 12,
    });
  });

  it('round-trips a non-round byte default unchanged', async () => {
    vi.mocked(QuotasApi.getDefaults).mockResolvedValue({ ...defaults, quota_bytes: 2_345_678_901 });
    const w = await mountPage();
    await w.find('[data-testid="quotas-defaults"]').trigger('submit');
    await flushPromises();

    expect(QuotasApi.updateDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ quota_bytes: 2_345_678_901 }),
    );
  });

  // A 2 MB override decoded to a custom value of 0, which `encode` rejected —
  // so the whole editor refused to save, the account's file count included.
  it('lets a sub-gigabyte byte override through, and its file-count sibling with it', async () => {
    vi.mocked(QuotasApi.listUsers).mockResolvedValue({
      users: [
        {
          ...row,
          overrides: { quota_bytes: 2_000_000, quota_files: -1, quota_upload_bytes: 0 },
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const w = await mountPage();
    await w.find('[data-testid="edit-row"]').trigger('click');
    await flushPromises();

    await w.find('select[name="edit-files-mode"]').setValue('custom');
    await w.find('input[name="edit-files-value"]').setValue('500');
    await w.find('[data-testid="quota-editor"]').trigger('submit');
    await flushPromises();

    expect(QuotasApi.updateUser).toHaveBeenCalledWith(7, {
      quota_bytes: 2_000_000,
      quota_files: 500,
      quota_upload_bytes: 0,
    });
    expect(w.find('[data-testid="quota-editor"]').exists()).toBe(false);
  });

  it('recomputes one account and re-reads its row', async () => {
    const w = await mountPage();
    await w.find('[data-testid="recompute-row"]').trigger('click');
    await flushPromises();
    expect(QuotasApi.recomputeUser).toHaveBeenCalledWith(7);
    expect(QuotasApi.getUser).toHaveBeenCalledWith(7);
  });

  // Note: `/api/admin/quotas` is mounted in the plain admin group today, so no
  // caller actually gets a 403 yet. This asserts the notice the page WOULD show
  // if the server answered 403 — the branch is kept for when it is scoped.
  it('renders the notice instead of a dead form if the server answers 403', async () => {
    vi.mocked(QuotasApi.getDefaults).mockRejectedValue({ response: { status: 403 } });
    vi.mocked(QuotasApi.listUsers).mockRejectedValue({ response: { status: 403 } });
    const w = await mountPage();
    expect(w.find('[data-testid="quotas-forbidden"]').exists()).toBe(true);
    expect(w.find('[data-testid="quotas-defaults"]').exists()).toBe(false);
    expect(w.text()).toContain(en.quotas.supertenantOnly);
  });
});
