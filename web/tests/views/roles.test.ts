// The role matrix: catalogue operations down, roles across.
//
// Two things the page must never get wrong. The admin column is not editable —
// the server answers 400 to a PUT on it — so it is rendered checked and
// disabled rather than as a control that fails on press. And a save sends the
// WHOLE permission list for one role (PUT replaces), in catalogue order, not
// only what changed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createI18n } from 'vue-i18n';

import Roles from '@/views/Roles.vue';
import { RolesApi } from '@/api/roles';
import en from '@/locales/en.json';
import tr from '@/locales/tr.json';

vi.mock('@/api/roles', async (original) => {
  const actual = await original<typeof import('@/api/roles')>();
  return {
    ...actual,
    RolesApi: { list: vi.fn(), update: vi.fn() },
  };
});

const catalogue = [
  { id: 'files.upload', group: 'write' as const },
  { id: 'files.delete', group: 'write' as const },
  { id: 'files.download', group: 'read' as const },
];

const roles = [
  { name: 'admin', permissions: [], editable: false },
  { name: 'user', permissions: ['files.upload', 'files.download'], editable: true },
  { name: 'viewer', permissions: ['files.download'], editable: true },
];

async function mountPage(locale = 'en') {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en', messages: { en, tr } });
  const w = mount(Roles, { global: { plugins: [i18n] } });
  await flushPromises();
  return w;
}

describe('Roles', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(RolesApi.list).mockResolvedValue({ roles: structuredClone(roles), catalogue });
  });

  it('builds the matrix from the server’s catalogue, grouped', async () => {
    const w = await mountPage();
    expect(w.find('[data-testid="roles-matrix"]').exists()).toBe(true);
    for (const op of catalogue) expect(w.find(`[data-testid="op-${op.id}"]`).exists()).toBe(true);
    for (const role of roles) {
      expect(w.find(`[data-testid="role-col-${role.name}"]`).exists()).toBe(true);
    }
    // Group headers and operation labels come from i18n, not from the id.
    expect(w.text()).toContain(en.roles.groups.write);
    expect(w.text()).toContain(en.roles.groups.read);
    expect(w.text()).toContain(en.roles.ops.files.upload.label);
    expect(w.text()).toContain(en.roles.ops.files.upload.hint);
  });

  it('shows the admin column as everything, checked and disabled', async () => {
    const w = await mountPage();
    for (const op of catalogue) {
      const box = w.find(`input[name="perm-admin-${op.id}"]`).element as HTMLInputElement;
      expect(box.checked, `admin ${op.id} checked`).toBe(true);
      expect(box.disabled, `admin ${op.id} disabled`).toBe(true);
    }
    expect(w.find(`[data-testid="role-col-admin"]`).text()).toContain(en.roles.adminHint);
    // No save button for a role the server will not change.
    expect(w.find('[data-testid="save-role-admin"]').exists()).toBe(false);
  });

  it('PUTs the whole list, in catalogue order, for the role that changed', async () => {
    vi.mocked(RolesApi.update).mockResolvedValue({
      name: 'viewer',
      permissions: ['files.upload', 'files.download'],
      editable: true,
    });
    const w = await mountPage();

    // Save is inert until the column differs from what the server sent.
    expect(
      (w.find('[data-testid="save-role-viewer"]').element as HTMLButtonElement).disabled,
    ).toBe(true);

    await w.find('input[name="perm-viewer-files.upload"]').setValue(true);
    expect(
      (w.find('[data-testid="save-role-viewer"]').element as HTMLButtonElement).disabled,
    ).toBe(false);

    await w.find('[data-testid="save-role-viewer"]').trigger('click');
    await flushPromises();

    expect(RolesApi.update).toHaveBeenCalledTimes(1);
    expect(RolesApi.update).toHaveBeenCalledWith('viewer', ['files.upload', 'files.download']);
    // Saved: the column is clean again and the other role was never touched.
    expect(
      (w.find('[data-testid="save-role-viewer"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('unchecking removes the operation from the list it sends', async () => {
    vi.mocked(RolesApi.update).mockResolvedValue({
      name: 'user',
      permissions: ['files.upload'],
      editable: true,
    });
    const w = await mountPage();
    await w.find('input[name="perm-user-files.download"]').setValue(false);
    await w.find('[data-testid="save-role-user"]').trigger('click');
    await flushPromises();
    expect(RolesApi.update).toHaveBeenCalledWith('user', ['files.upload']);
  });
});
