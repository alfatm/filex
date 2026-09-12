import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DUPLICATE_NAME } from '@/data/repository';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import NewFileModal from './NewFileModal.vue';

const created: Node = { id: 'main://Docs/Untitled.txt', name: 'Untitled.txt', kind: 'file', parentId: 'main://Docs', size: 0, ownerId: 'u1', shared: false, starred: false };

describe('NewFileModal', () => {
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
  });

  function open() {
    wrapper = mount(NewFileModal, { attachTo: document.body, global: { plugins: [i18n] } });
    return wrapper;
  }
  const input = () => document.body.querySelector('input') as HTMLInputElement;
  const createButton = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Create') as HTMLButtonElement;

  it('offers a name with its extension left out of the highlight, and creates through the store', async () => {
    const createFile = vi.spyOn(useFilesStore(), 'createFile').mockResolvedValue(created);
    const modal = open();
    await flushPromises();

    expect(input().value).toBe('Untitled.txt');
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 'Untitled'.length]);

    createButton().click();
    await flushPromises();
    expect(createFile).toHaveBeenCalledWith('Untitled.txt');
    expect(modal.emitted('close')).toHaveLength(1);
  });

  it('puts a name collision under the field, in words', async () => {
    vi.spyOn(useFilesStore(), 'createFile').mockRejectedValue(new Error(DUPLICATE_NAME));
    const modal = open();
    await flushPromises();

    createButton().click();
    await flushPromises();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(i18n.global.t('modal.duplicateName'));
    expect(modal.emitted('close')).toBeUndefined();
  });

  it('has nothing to create from an empty name', async () => {
    const createFile = vi.spyOn(useFilesStore(), 'createFile').mockResolvedValue(created);
    open();
    await flushPromises();

    input().value = '   ';
    input().dispatchEvent(new Event('input'));
    await flushPromises();
    expect(createButton().disabled).toBe(true);
    createButton().click();
    await flushPromises();
    expect(createFile).not.toHaveBeenCalled();
  });
});
