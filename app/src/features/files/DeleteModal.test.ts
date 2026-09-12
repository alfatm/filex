import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it } from 'vitest';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import DeleteModal from './DeleteModal.vue';

const node: Node = { id: 'demo://Docs/brief.pdf', name: 'brief.pdf', kind: 'file', parentId: 'demo://Docs', size: 10, ownerId: 'u1', shared: false, starred: false };

/**
 * The retention period is the server's (`trash.retention_days`), and no route tells a non-administrator what it is;
 * the item being deleted is not in the trash yet, so it carries no countdown either. This dialog used to promise
 * "within 30 days" in all three languages regardless — right only on an install that never changed the setting.
 * The Trash page's banner is where a real number is stated, from the rows it can actually see.
 */
describe('DeleteModal', () => {
  let wrapper: { unmount: () => void } | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });

  it.each(['en', 'ru', 'tr'] as const)('promises no retention period it was never told, in %s', async (locale) => {
    setActivePinia(createPinia());
    i18n.global.locale.value = locale;
    wrapper = mount(DeleteModal, { attachTo: document.body, props: { variant: 'trash', nodes: [node] }, global: { plugins: [i18n] } });
    await flushPromises();

    const body = document.body.textContent ?? '';
    expect(body).toContain('brief.pdf');
    expect(body).not.toMatch(/\d+\s*(days|дн|gün)/i);
  });
});
