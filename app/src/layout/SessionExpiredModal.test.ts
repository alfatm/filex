import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { useAuthStore } from '@/stores/auth';
import SessionExpiredModal from './SessionExpiredModal.vue';

/**
 * The prompt itself, and the two things about it that are not the store's business: it is absent until a session
 * is actually declared lost, and when it appears it is ABOVE the other dialogs — a preview or the settings modal
 * can be open at the moment the cookie runs out, and both of those are `z-40`.
 */
describe('SessionExpiredModal', () => {
  let wrapper: { unmount: () => void } | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });

  it('shows nothing until the session is declared lost, then outranks the other dialogs', async () => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    wrapper = mount(SessionExpiredModal, { attachTo: document.body, global: { plugins: [i18n] } });
    await flushPromises();
    expect(document.body.textContent).not.toContain('session');

    useAuthStore().expired = true;
    await flushPromises();

    const dialog = document.querySelector('[role="dialog"]');
    expect(document.body.textContent).toContain('Your session has ended');
    // The class reaches the rendered element rather than being dropped by the component in between.
    expect(dialog?.closest('.\\!z-50') ?? document.querySelector('.\\!z-50')).not.toBeNull();
  });
});
