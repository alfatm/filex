import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import router, { routes } from './router';

const build = () => createRouter({ history: createMemoryHistory(), routes: [...routes] });

describe('routes', () => {
  // An address with no screen behind it used to match nothing at all: the shell drew itself around an empty
  // column, with no message and no way back.
  it('sends an address it has no screen for to the page that says so', async () => {
    const router = build();
    await router.push('/nowhere/at/all');
    expect(router.currentRoute.value.name).toBe('notFound');
  });

  it('leaves every address it does know exactly where it was', async () => {
    const router = build();
    await router.push('/files/demo/Design');
    expect(router.currentRoute.value.name).toBe('files');
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('home');
    await router.push('/trash');
    expect(router.currentRoute.value.name).toBe('trash');
  });
});

/*
 * The guard on the real router — the exported `routes` carry no behaviour, and it is the guard that decides who
 * may be where. Each case gets its own pinia so the auth store starts having asked nobody, which is what a cold
 * load looks like.
 */
describe('the session gate', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    resetMock();
    await router.replace('/');
    await router.isReady();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends a visitor with no session to the sign-in screen, carrying where they were going', async () => {
    await repository.signOut();
    setActivePinia(createPinia());
    await router.push('/trash');
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/trash');
  });

  it('keeps somebody who is signed in off the sign-in screen', async () => {
    await router.push('/login');
    expect(router.currentRoute.value.name).toBe('home');
  });

  // A dropped connection is not a sign-out: the page behind this says so itself, where a form would have guessed.
  it('lets a navigation through when the server cannot be reached at all', async () => {
    vi.spyOn(repository, 'session').mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setActivePinia(createPinia());
    await router.push('/starred');
    expect(router.currentRoute.value.name).toBe('starred');
  });
});
