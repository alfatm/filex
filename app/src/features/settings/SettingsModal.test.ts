import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { INVALID_CODE, WRONG_PASSWORD } from '@/data/repository';
import type { AuthMethods, TotpEnrollment } from '@/data/types';
import { i18n } from '@/i18n';
import SettingsModal from './SettingsModal.vue';

const local: AuthMethods = { provider: 'local', changePassword: true, totpEnabled: false };
const enrollment: TotpEnrollment = {
  secret: 'JBSWY3DPEHPK3PXP',
  otpauthUrl: 'otpauth://totp/filex:ada?secret=JBSWY3DPEHPK3PXP',
  qrSvg: '<svg data-qr="1"></svg>',
  recoveryCodes: Array.from({ length: 10 }, (_, i) => `AAAAA-0000${i}`),
};
const t = (key: string) => i18n.global.t(key);

describe('SettingsModal — two-factor authentication', () => {
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'notifyPrefs').mockRejectedValue(new Error('off'));
    vi.spyOn(repository, 'listSessions').mockRejectedValue(new Error('older server'));
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
  });

  const buttons = () => [...document.body.querySelectorAll('button')];
  const byText = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
  /** The 2FA row: the element carrying the row's label, whatever kind of element it is. */
  function twoFactorRow() {
    const label = [...document.body.querySelectorAll('span')].find((s) => s.textContent?.trim() === t('settings.security.twoFactor'));
    return label?.parentElement ?? null;
  }
  const alert = () => document.body.querySelector('[role="alert"]')?.textContent?.trim();

  async function openSecurity() {
    wrapper = mount(SettingsModal, { attachTo: document.body, global: { plugins: [i18n] } });
    await flushPromises();
    byText(t('settings.nav.security'))?.click();
    await flushPromises();
  }

  function typeInto(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('enrols, refuses a wrong code, and hands over the recovery codes once the right one is in', async () => {
    const methods = vi.spyOn(repository, 'authMethods').mockResolvedValueOnce(local).mockResolvedValue({ ...local, totpEnabled: true });
    const enroll = vi.spyOn(repository, 'totpEnroll').mockResolvedValue(enrollment);
    const verify = vi.spyOn(repository, 'totpVerify').mockRejectedValueOnce(new Error(INVALID_CODE)).mockResolvedValue(undefined);
    await openSecurity();

    const row = twoFactorRow();
    expect(row?.tagName).toBe('BUTTON');
    expect(row?.textContent).toContain(t('settings.security.twoFactorOff'));
    row?.click();
    await flushPromises();

    expect(enroll).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-qr]')).not.toBeNull();
    expect(document.body.textContent).toContain(enrollment.secret);

    const code = document.body.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    typeInto(code, '000000');
    await flushPromises();
    byText(t('settings.security.verify'))?.click();
    await flushPromises();
    expect(verify).toHaveBeenCalledWith('000000');
    expect(alert()).toBe(t('settings.security.wrongCode'));

    typeInto(code, '123456');
    await flushPromises();
    byText(t('settings.security.verify'))?.click();
    await flushPromises();

    const codes = [...document.body.querySelectorAll('ul[aria-label] li')].map((li) => li.textContent?.trim());
    expect(codes).toEqual(enrollment.recoveryCodes);
    expect(document.body.textContent).toContain(t('settings.security.recoveryCodesHint'));
    expect(methods).toHaveBeenCalledTimes(2);
    byText(t('settings.security.done'))?.click();
    await flushPromises();
    expect(twoFactorRow()?.textContent).toContain(t('settings.security.twoFactorOn'));
  });

  it('leaves the row inert on a realm whose second step is the provider’s', async () => {
    vi.spyOn(repository, 'authMethods').mockResolvedValue({ provider: 'oidc', changePassword: false, totpEnabled: false });
    const enroll = vi.spyOn(repository, 'totpEnroll').mockResolvedValue(enrollment);
    await openSecurity();

    const row = twoFactorRow();
    expect(row?.tagName).toBe('DIV');
    expect(row?.textContent).toContain(t('settings.security.twoFactorProvider'));
    row?.click();
    await flushPromises();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('turns off only with the password and a code, and names which one was wrong', async () => {
    vi.spyOn(repository, 'authMethods').mockResolvedValueOnce({ ...local, totpEnabled: true }).mockResolvedValue(local);
    const disable = vi
      .spyOn(repository, 'totpDisable')
      .mockRejectedValueOnce(new Error(WRONG_PASSWORD))
      .mockRejectedValueOnce(new Error(INVALID_CODE))
      .mockResolvedValue(undefined);
    await openSecurity();

    expect(twoFactorRow()?.textContent).toContain(t('settings.security.twoFactorOn'));
    twoFactorRow()?.click();
    await flushPromises();

    const password = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    const code = document.body.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
    const turnOff = () => byText(t('settings.security.twoFactorTurnOff')) as HTMLButtonElement;
    expect(turnOff().disabled).toBe(true);

    typeInto(password, 'nope');
    typeInto(code, 'AAAAA-00001');
    await flushPromises();
    turnOff().click();
    await flushPromises();
    expect(disable).toHaveBeenLastCalledWith('nope', 'AAAAA-00001');
    expect(alert()).toBe(t('settings.security.wrongPassword'));

    turnOff().click();
    await flushPromises();
    expect(alert()).toBe(t('settings.security.wrongCode'));

    turnOff().click();
    await flushPromises();
    expect(disable).toHaveBeenCalledTimes(3);
    expect(twoFactorRow()?.tagName).toBe('BUTTON');
    expect(twoFactorRow()?.textContent).toContain(t('settings.security.twoFactorOff'));
  });
});
