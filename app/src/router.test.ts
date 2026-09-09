import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { routes } from './router';

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
