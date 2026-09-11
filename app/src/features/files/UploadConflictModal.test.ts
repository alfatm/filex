import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import UploadConflictModal from './UploadConflictModal.vue';
import type { UploadItem } from './uploadStore';

const item = (patch: Partial<UploadItem>): UploadItem => ({
  id: 1,
  name: 'brief.pdf',
  size: 10,
  progress: 0,
  state: 'conflict',
  parentId: 'main://Docs',
  conflict: 'exists',
  ...patch,
});

/** The dialog portals to <body>, so its buttons are found there, by their label. */
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

describe('UploadConflictModal', () => {
  let wrapper: ReturnType<typeof mount> | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });

  function open(patch: Partial<UploadItem>, offerAll = false) {
    i18n.global.locale.value = 'en';
    wrapper = mount(UploadConflictModal, { attachTo: document.body, props: { item: item(patch), offerAll }, global: { plugins: [i18n] } });
    return wrapper;
  }

  it('asks about a taken name, naming the file and the folder, and emits the choice', async () => {
    const w = open({});
    await flushPromises();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Replace “brief.pdf”?');
    expect(text).toContain('“Docs”');
    expect(document.body.querySelector('[role="checkbox"]')).toBeNull();

    button('Replace').click();
    expect(w.emitted('decide')).toEqual([['replace', false]]);
  });

  it('asks about a target being uploaded right now, offering Retry instead of Replace', async () => {
    const w = open({ conflict: 'inProgress' });
    await flushPromises();
    expect(document.body.textContent).toContain('“brief.pdf” is being uploaded right now');
    expect(Array.from(document.body.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Replace')).toBe(false);

    button('Retry').click();
    expect(w.emitted('decide')).toEqual([['retry', false]]);
  });

  it('carries the "apply to all" box when more rows are still to come', async () => {
    const w = open({}, true);
    await flushPromises();
    (document.body.querySelector('[role="checkbox"]') as HTMLButtonElement).click();
    await flushPromises();
    button('Keep both').click();
    expect(w.emitted('decide')).toEqual([['keepBoth', true]]);
  });

  it('reads closing as Skip', async () => {
    const w = open({});
    await flushPromises();
    button('Skip').click();
    expect(w.emitted('decide')).toEqual([['skip', false]]);
  });
});
