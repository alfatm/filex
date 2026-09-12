import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { useBrandingStore } from './branding';

const PRIMARY = ['--c-primary', '--c-primary-hover', '--c-primary-soft', '--c-primary-ring', '--c-primary-tint'];

function clearTokens() {
  for (const token of PRIMARY) document.documentElement.style.removeProperty(token);
}

async function load(answer: { name: string; logoUrl: string; accent: string } | Error) {
  const spy = vi.spyOn(repository, 'branding').mockImplementation(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  const store = useBrandingStore();
  await store.load();
  spy.mockRestore();
  return store;
}

describe('branding store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearTokens();
  });
  afterEach(clearTokens);

  it('paints the accent over all five primary tokens', async () => {
    await load({ name: 'Acme Drive', logoUrl: '/brand.svg', accent: '#c0392b' });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--c-primary')).toBe('#c0392b');
    // The four washes are translucent, which is what makes one hex enough for a light and a dark page alike.
    expect(style.getPropertyValue('--c-primary-soft')).toBe('rgba(192, 57, 43, 0.14)');
    expect(style.getPropertyValue('--c-primary-ring')).toBe('rgba(192, 57, 43, 0.45)');
    expect(style.getPropertyValue('--c-primary-tint')).toBe('rgba(192, 57, 43, 0.07)');
    // Hover is the one opaque one: the server's own 0.85 multiply for a light page, lighter for a dark one.
    expect(style.getPropertyValue('--c-primary-hover')).toBe('light-dark(rgb(163, 48, 37), rgb(227, 67, 51))');
  });

  it('expands a three-digit hex', async () => {
    await load({ name: '', logoUrl: '', accent: '#0a3' });
    expect(document.documentElement.style.getPropertyValue('--c-primary-soft')).toBe('rgba(0, 170, 51, 0.14)');
  });

  // An unbranded install answers with empty strings, and the app must then look exactly as it ships.
  it('leaves the tokens alone when nothing is branded', async () => {
    const store = await load({ name: '', logoUrl: '', accent: '' });
    expect(store.name).toBe('');
    expect(document.documentElement.style.getPropertyValue('--c-primary')).toBe('');
  });

  // Branding is decoration. A server that cannot answer must not stop the app from opening.
  it('falls back to filex when the request fails', async () => {
    const store = await load(new Error('offline'));
    expect(store.name).toBe('');
    expect(store.logoUrl).toBe('');
    expect(document.documentElement.style.getPropertyValue('--c-primary')).toBe('');
  });
});
