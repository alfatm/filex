import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { TOTP_REQUIRED } from '@/data/repository';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import LoginPage from './LoginPage.vue';

const Page = { template: '<div />' };

/** Mounts the screen at `where`, on a router of its own so the app's real guard is not in the way. */
async function mountLogin(where = '/login') {
  setActivePinia(createPinia());
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: LoginPage },
      { path: '/', name: 'home', component: Page },
      { path: '/trash', name: 'trash', component: Page },
    ],
  });
  await router.push(where);
  await router.isReady();
  const wrapper = mount(LoginPage, { global: { plugins: [router, i18n] } });
  // onMounted asks the server which realms it offers before the form settles into its final shape.
  await flushPromises();
  return { wrapper, router };
}

async function submit(wrapper: Awaited<ReturnType<typeof mountLogin>>['wrapper'], identifier: string, password: string) {
  await wrapper.get('#login-identifier').setValue(identifier);
  await wrapper.get('#login-password').setValue(password);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
}

describe('LoginPage', () => {
  beforeEach(async () => {
    resetMock();
    await repository.signOut();
  });
  afterEach(() => vi.restoreAllMocks());

  it('signs in and resumes the navigation that was refused', async () => {
    const { wrapper, router } = await mountLogin('/login?redirect=/trash');
    await submit(wrapper, 'demo@filex.local', 'demo');
    expect(router.currentRoute.value.path).toBe('/trash');
  });

  // The value reaches router.push; an app that follows "//elsewhere" out of its own origin is an open redirect.
  it('ignores a redirect that is not an address of this app', async () => {
    const { wrapper, router } = await mountLogin('/login?redirect=//evil.example/x');
    await submit(wrapper, 'demo@filex.local', 'demo');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('says what was wrong and stays put', async () => {
    const { wrapper, router } = await mountLogin();
    await submit(wrapper, 'demo@filex.local', 'wrong');
    expect(wrapper.get('[role="alert"]').text()).toBe('Wrong e-mail, username or password');
    expect(router.currentRoute.value.name).toBe('login');
  });

  /*
   * The code field opens itself the first time the server asks for one: the account has a second factor, the
   * password was right, and there is no other way for the person to supply it.
   */
  it('opens the second-factor field when the server asks for a code', async () => {
    vi.spyOn(repository, 'signIn').mockRejectedValue(new Error(TOTP_REQUIRED));
    const { wrapper } = await mountLogin();
    expect(wrapper.find('#login-totp').exists()).toBe(false);
    await submit(wrapper, 'demo@filex.local', 'demo');
    expect(wrapper.find('#login-totp').exists()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('That two-factor code was missing or wrong');
  });

  it('keeps the password hidden until the eye is pressed', async () => {
    const { wrapper } = await mountLogin();
    expect(wrapper.get('#login-password').attributes('type')).toBe('password');
    await wrapper.get('[aria-label="Show password"]').trigger('click');
    expect(wrapper.get('#login-password').attributes('type')).toBe('text');
  });

  // No identity provider, no button: the demo repository answers `null` for the start URL.
  it('offers the password form alone when the installation has no provider', async () => {
    const { wrapper } = await mountLogin();
    expect(wrapper.find('form').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('SSO');
  });

  /** An SSO-first install (FILEX_OIDC_AUTO_REDIRECT), which offers a local realm as well. */
  function ssoFirst() {
    vi.spyOn(repository, 'authOptions').mockResolvedValue({ drivers: ['local', 'oidc'], oidcAutoRedirect: true, version: '' });
    // The demo has no provider to hand off to, so the URL builder is what stands in for one here.
    const startUrl = vi.spyOn(repository, 'oidcStartUrl').mockReturnValue('/api/auth/oidc/start?provider=oidc');
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
    return { startUrl, assign };
  }

  it('hands an SSO-first install straight to the provider, and lands the person back in this app', async () => {
    const { startUrl, assign } = ssoFirst();
    const { wrapper } = await mountLogin();
    // Where filex is told to land them afterwards: this app, not the console.
    expect(startUrl).toHaveBeenCalledWith('/');
    expect(assign).toHaveBeenCalledWith('/api/auth/oidc/start?provider=oidc');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  // The break-glass path: an account the provider does not carry still has to get in.
  it('keeps the password form reachable behind ?local=1', async () => {
    const { assign } = ssoFirst();
    const { wrapper } = await mountLogin('/login?local=1');
    expect(assign).not.toHaveBeenCalled();
    expect(wrapper.find('form').exists()).toBe(true);
  });

  // Bouncing somebody straight back to the provider that just failed is a loop they cannot read a word of.
  it('does not hand off again after the provider refused', async () => {
    vi.spyOn(repository, 'authOptions').mockResolvedValue({ drivers: ['oidc'], oidcAutoRedirect: true, version: '' });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location);
    const { wrapper } = await mountLogin('/login?error=oidc');
    expect(assign).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('did not sign you in');
  });
});
