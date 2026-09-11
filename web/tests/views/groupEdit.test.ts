// One group's page: its form, and its membership.
//
// Membership is edited one account at a time. The add flow has a trap worth a
// test: the picker must not offer accounts that are already members, and after
// an add the group is re-read rather than patched from whatever the picker
// happened to be showing.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import GroupEdit from '@/views/GroupEdit.vue';
import { GroupsApi } from '@/api/groups';
import { UsersApi } from '@/api/users';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

const push = vi.fn();
const replace = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace }),
  useRoute: () => ({ params: { id: '3' } }),
}));

vi.mock('@/api/groups', async (original) => {
  const actual = await original<typeof import('@/api/groups')>();
  return {
    ...actual,
    GroupsApi: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      setMembers: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
    },
  };
});

vi.mock('@/api/users', async (original) => {
  const actual = await original<typeof import('@/api/users')>();
  return { ...actual, UsersApi: { ...actual.UsersApi, list: vi.fn() } };
});

const ada = { id: 11, email: 'ada@example.com', display_name: 'Ada', role: 'user' as const };
const grace = { id: 12, email: 'grace@example.com', display_name: 'Grace', role: 'viewer' as const };

const detail = {
  id: 3,
  name: 'Engineering',
  description: 'Everyone who ships',
  member_count: 1,
  created_at: '2026-01-02T03:04:05Z',
  members: [ada],
};

function userPage() {
  return {
    items: [
      { ...ada, created_at: '', updated_at: '' },
      { ...grace, created_at: '', updated_at: '' },
    ],
    total: 2,
    page: 1,
    page_size: 10,
  };
}

async function mountPage(locale = 'en') {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(GroupEdit, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

describe('GroupEdit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    push.mockReset();
    vi.mocked(GroupsApi.get).mockResolvedValue(structuredClone(detail));
    vi.mocked(GroupsApi.update).mockResolvedValue(structuredClone(detail));
    vi.mocked(GroupsApi.addMember).mockResolvedValue(undefined);
    vi.mocked(GroupsApi.removeMember).mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(UsersApi.list).mockResolvedValue(userPage() as any);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders the group and its members', async () => {
    const w = await mountPage();
    expect((w.find('input[name="group-name"]').element as HTMLInputElement).value).toBe(
      'Engineering',
    );
    expect(w.text()).toContain('ada@example.com');
  });

  it('saves the form with PATCH', async () => {
    const w = await mountPage();
    await w.find('input[name="group-name"]').setValue('Platform');
    await w.find('[data-testid="group-form"]').trigger('submit');
    await flushPromises();
    expect(GroupsApi.update).toHaveBeenCalledWith(3, {
      name: 'Platform',
      description: 'Everyone who ships',
    });
  });

  it('removes a member after confirming', async () => {
    const w = await mountPage();
    await w.find('[data-testid="member-remove"]').trigger('click');
    await flushPromises();
    expect(window.confirm).toHaveBeenCalled();
    expect(GroupsApi.removeMember).toHaveBeenCalledWith(3, 11);
    expect(w.find('tbody').text()).not.toContain('ada@example.com');
    expect(w.text()).toContain(en.groups.noMembers);
    // …and the account is offered by the picker again.
    const values = w
      .findAll('select[name="member-pick"] option')
      .map((o) => (o.element as HTMLOptionElement).value);
    expect(values).toContain('11');
  });

  it('offers only accounts that are not members yet, and adds the picked one', async () => {
    const w = await mountPage();
    const options = w.findAll('select[name="member-pick"] option');
    const values = options.map((o) => (o.element as HTMLOptionElement).value);
    expect(values).toContain('12');
    expect(values, 'a current member is not offered again').not.toContain('11');

    await w.find('select[name="member-pick"]').setValue('12');
    await w.find('[data-testid="member-add"]').trigger('click');
    await flushPromises();

    expect(GroupsApi.addMember).toHaveBeenCalledWith(3, 12);
    // The add endpoint answers no body, so the group is re-read.
    expect(GroupsApi.get).toHaveBeenCalledTimes(2);
  });

  it('says the group has no members when it has none', async () => {
    vi.mocked(GroupsApi.get).mockResolvedValue({ ...structuredClone(detail), members: [] });
    const w = await mountPage();
    expect(w.text()).toContain(en.groups.noMembers);
  });
});
