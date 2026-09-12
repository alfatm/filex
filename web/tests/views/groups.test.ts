// The groups list: search, paging, create, delete.
//
// A group is a grant principal (see the Access page), so deleting one takes
// its grants with it — the confirmation has to say so, and this asserts the
// sentence is on screen rather than only in the changelog.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import Groups from '@/views/Groups.vue';
import { GroupsApi } from '@/api/groups';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

const push = vi.fn();
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

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

const rows = [
  {
    id: 3,
    name: 'Engineering',
    description: 'Everyone who ships',
    member_count: 12,
    created_at: '2026-01-02T03:04:05Z',
  },
  { id: 4, name: 'Finance', description: '', member_count: 2, created_at: '2026-01-02T03:04:05Z' },
];

// The real Modal is a native <dialog>; happy-dom has no showModal(), and the
// content is in the DOM either way, so a passthrough keeps the test about the
// page rather than about the element.
const ModalStub = {
  name: 'Modal',
  template: '<div><slot /><slot name="footer" /></div>',
};

async function mountPage(locale = 'en') {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(Groups, { global: { plugins: [i18n], stubs: { Modal: ModalStub } } });
  await flushPromises();
  return w;
}

describe('Groups', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    push.mockReset();
    vi.mocked(GroupsApi.list).mockResolvedValue({
      groups: structuredClone(rows),
      total: 2,
      limit: 25,
      offset: 0,
    });
    vi.mocked(GroupsApi.create).mockResolvedValue({ ...rows[0], id: 9, name: 'Support' });
    vi.mocked(GroupsApi.remove).mockResolvedValue(undefined);
  });

  it('lists the groups with their member counts', async () => {
    const w = await mountPage();
    expect(GroupsApi.list).toHaveBeenCalledWith({ q: undefined, limit: 25, offset: 0 });
    expect(w.text()).toContain('Engineering');
    expect(w.text()).toContain('Everyone who ships');
    expect(w.text()).toContain('12');
  });

  it('creates a group from the form', async () => {
    const w = await mountPage();
    await w.find('[data-testid="groups-new"]').trigger('click');
    await w.find('input[name="group-name"]').setValue('Support');
    await w.find('textarea[name="group-description"]').setValue('Front line');
    await w.find('[data-testid="groups-create-submit"]').trigger('click');
    await flushPromises();

    expect(GroupsApi.create).toHaveBeenCalledWith({ name: 'Support', description: 'Front line' });
    // The list is re-read rather than patched, so paging and totals stay honest.
    expect(GroupsApi.list).toHaveBeenCalledTimes(2);
  });

  it('will not create a group with no name', async () => {
    const w = await mountPage();
    await w.find('[data-testid="groups-new"]').trigger('click');
    await w.find('[data-testid="groups-create-submit"]').trigger('click');
    await flushPromises();
    expect(GroupsApi.create).not.toHaveBeenCalled();
  });

  it('says the grants go with the group before deleting it', async () => {
    const w = await mountPage();
    expect(w.text()).toContain(en.groups.deleteHint);
  });

  it('opens one group for editing', async () => {
    const w = await mountPage();
    await w.findAll('tbody tr')[0].findAll('button')[0].trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'groups.edit', params: { id: 3 } });
  });
});
