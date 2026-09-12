// The Access page: storages that enforce RBAC, the new-grant form, and the
// grant table.
//
// A grant belongs either to an account or to a group, and the two are told
// apart by one field. Get it wrong in the wrong direction and a DELETE aimed
// at group #7 revokes user #7's access instead — which is why the revoke and
// the level change assert the `principal` argument, not just the id.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import AdminGrants from '@/views/AdminGrants.vue';
import { AdminGrantsApi } from '@/api/grants';
import { GroupsApi } from '@/api/groups';
import { StoragesApi } from '@/api/storages';
import { UsersApi } from '@/api/users';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

vi.mock('@/api/grants', async (original) => {
  const actual = await original<typeof import('@/api/grants')>();
  return {
    ...actual,
    AdminGrantsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  };
});
vi.mock('@/api/groups', async (original) => {
  const actual = await original<typeof import('@/api/groups')>();
  return { ...actual, GroupsApi: { ...actual.GroupsApi, list: vi.fn() } };
});
vi.mock('@/api/users', async (original) => {
  const actual = await original<typeof import('@/api/users')>();
  return { ...actual, UsersApi: { ...actual.UsersApi, list: vi.fn() } };
});
vi.mock('@/api/storages', async (original) => {
  const actual = await original<typeof import('@/api/storages')>();
  return { ...actual, StoragesApi: { ...actual.StoragesApi, list: vi.fn(), update: vi.fn() } };
});

const storage = {
  id: 1,
  name: 'primary',
  driver: 'local',
  enabled: true,
  config: {},
  read_only: false,
  rbac_enabled: false,
  created_at: '',
  updated_at: '',
};

const userGrant = {
  id: 10,
  storage_id: 1,
  storage_name: 'primary',
  path: 'reports',
  path_prefix: 'reports',
  is_dir: true,
  principal: 'user' as const,
  user_id: 11,
  user_email: 'ada@example.com',
  user_display_name: 'Ada',
  level: 'viewer' as const,
  created_at: '',
};

// A group row carries no user_* fields at all — the page has to survive that.
const groupGrant = {
  id: 20,
  storage_id: 1,
  storage_name: 'primary',
  path: 'finance',
  path_prefix: 'finance',
  is_dir: true,
  principal: 'group' as const,
  group_id: 3,
  group_name: 'Engineering',
  level: 'editor' as const,
  created_at: '',
};

async function mountPage(locale = 'en') {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(AdminGrants, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

describe('AdminGrants (Access)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(AdminGrantsApi.list).mockResolvedValue([
      structuredClone(userGrant),
      structuredClone(groupGrant),
    ]);
    vi.mocked(AdminGrantsApi.remove).mockResolvedValue(undefined);
    vi.mocked(AdminGrantsApi.update).mockResolvedValue(undefined);
    // What the server ACTUALLY answers a create with: the bare DB row
    // (model.FileGroupGrant). No principal, path, storage_name or group_name —
    // so it is not a table row and must never be spliced into the list.
    vi.mocked(AdminGrantsApi.create).mockResolvedValue(
      {
        id: 21,
        storage_id: 1,
        path_prefix: 'finance',
        is_dir: true,
        group_id: 3,
        level: 'editor',
        created_at: '2024-01-01T00:00:00Z',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(StoragesApi.list).mockResolvedValue([structuredClone(storage)] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(StoragesApi.update).mockResolvedValue({ ...storage, rbac_enabled: true } as any);
    vi.mocked(GroupsApi.list).mockResolvedValue({
      groups: [
        {
          id: 3,
          name: 'Engineering',
          description: '',
          member_count: 1,
          created_at: '',
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(UsersApi.list).mockResolvedValue({
      items: [{ id: 11, email: 'ada@example.com', display_name: 'Ada', role: 'user' }],
      total: 1,
      page: 1,
      page_size: 10,
    } as any);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('marks the group row with a badge and names the group', async () => {
    const w = await mountPage();
    expect(w.find('[data-testid="group-badge-group:20"]').exists()).toBe(true);
    expect(w.find('[data-testid="group-badge-user:10"]').exists()).toBe(false);
    expect(w.text()).toContain('Engineering');
    expect(w.text()).toContain('ada@example.com');
  });

  it('revokes a group row with principal=group and a user row without it', async () => {
    const w = await mountPage();
    await w.find('[data-testid="revoke-group:20"]').trigger('click');
    await flushPromises();
    expect(AdminGrantsApi.remove).toHaveBeenCalledWith(20, 'group');

    await w.find('[data-testid="revoke-user:10"]').trigger('click');
    await flushPromises();
    expect(AdminGrantsApi.remove).toHaveBeenCalledWith(10, 'user');
  });

  it('PATCHes the level when the inline select changes', async () => {
    const w = await mountPage();
    await w.find('select[name="level-group:20"]').setValue('owner');
    await flushPromises();
    expect(AdminGrantsApi.update).toHaveBeenCalledWith(20, 'owner', 'group');
  });

  it('filters the table by principal', async () => {
    const w = await mountPage();
    await w.find('[data-testid="principal-filter"]').setValue('group');
    expect(w.find('tbody').text()).toContain('Engineering');
    expect(w.find('tbody').text()).not.toContain('ada@example.com');
  });

  it('POSTs user_id when the principal is an account', async () => {
    const w = await mountPage();
    await w.find('select[name="grant-storage"]').setValue('1');
    await w.find('input[name="grant-path"]').setValue('reports');
    await w.find('select[name="grant-user"]').setValue('11');
    await w.find('[data-testid="new-grant"]').trigger('submit');
    await flushPromises();

    expect(AdminGrantsApi.create).toHaveBeenCalledWith({
      storage_id: 1,
      path: 'reports',
      is_dir: true,
      level: 'viewer',
      user_id: 11,
    });
  });

  it('POSTs group_id when the principal is a group', async () => {
    const w = await mountPage();
    await w.find('select[name="grant-storage"]').setValue('1');
    await w.find('select[name="grant-principal"]').setValue('group');
    await flushPromises();
    await w.find('select[name="grant-group"]').setValue('3');
    await w.find('select[name="grant-level"]').setValue('editor');
    await w.find('[data-testid="new-grant"]').trigger('submit');
    await flushPromises();

    expect(AdminGrantsApi.create).toHaveBeenCalledWith({
      storage_id: 1,
      path: '',
      is_dir: true,
      level: 'editor',
      group_id: 3,
    });
  });

  // The POST answer is a bare DB row, not a table row: splicing it in produced a
  // row with an empty Storage cell, the name "#undefined" and no `path` at all —
  // and the search box, which lowercases every row's path, then blanked the table.
  it('re-reads the list after a create instead of splicing the POST answer in', async () => {
    const w = await mountPage();
    expect(AdminGrantsApi.list).toHaveBeenCalledTimes(1);

    await w.find('select[name="grant-storage"]').setValue('1');
    await w.find('select[name="grant-principal"]').setValue('group');
    await flushPromises();
    await w.find('select[name="grant-group"]').setValue('3');
    await w.find('[data-testid="new-grant"]').trigger('submit');
    await flushPromises();

    expect(AdminGrantsApi.list).toHaveBeenCalledTimes(2);
    expect(w.find('tbody').text()).not.toContain('#undefined');

    // The page's own search box (the first one; the pickers come later in the DOM).
    await w.findAll('input[type="search"]')[0].setValue('finance');
    await flushPromises();
    expect(w.find('tbody').text()).toContain('Engineering');
  });

  // `file_grants` and `file_group_grants` have independent id sequences, so a
  // user row and a group row can both be #7. Identity is the pair.
  it('revokes group #7 without dropping user #7 from the table', async () => {
    vi.mocked(AdminGrantsApi.list).mockResolvedValue([
      { ...structuredClone(userGrant), id: 7 },
      { ...structuredClone(groupGrant), id: 7 },
    ]);
    const w = await mountPage();
    expect(w.findAll('tbody tr')).toHaveLength(2);

    await w.find('[data-testid="revoke-group:7"]').trigger('click');
    await flushPromises();

    expect(AdminGrantsApi.remove).toHaveBeenCalledWith(7, 'group');
    const body = w.find('tbody').text();
    expect(body).toContain('ada@example.com');
    expect(body).not.toContain('Engineering');
  });

  it('changes the level of group #7 without repainting user #7', async () => {
    vi.mocked(AdminGrantsApi.list).mockResolvedValue([
      { ...structuredClone(userGrant), id: 7 },
      { ...structuredClone(groupGrant), id: 7 },
    ]);
    const w = await mountPage();
    await w.find('select[name="level-group:7"]').setValue('owner');
    await flushPromises();

    expect(AdminGrantsApi.update).toHaveBeenCalledWith(7, 'owner', 'group');
    expect((w.find('select[name="level-user:7"]').element as HTMLSelectElement).value).toBe(
      'viewer',
    );
  });

  it('shows the server’s sentence when RBAC is off on the storage', async () => {
    const message = 'enable RBAC on this storage first';
    vi.mocked(AdminGrantsApi.create).mockRejectedValue(new Error(message));
    const w = await mountPage();
    await w.find('select[name="grant-storage"]').setValue('1');
    await w.find('select[name="grant-user"]').setValue('11');
    await w.find('[data-testid="new-grant"]').trigger('submit');
    await flushPromises();
    expect(w.find('[data-testid="grant-error"]').text()).toBe(message);
  });

  it('turns RBAC on for a storage from this page', async () => {
    const w = await mountPage();
    expect(w.find('[data-testid="rbac-storages"]').text()).toContain('primary');
    await w.find('button[id="rbac-1"]').trigger('click');
    await flushPromises();
    expect(StoragesApi.update).toHaveBeenCalledWith(1, { rbac_enabled: true });
  });
});
