import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { resetMock } from '@/data/mock';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import SettingsModal from './SettingsModal.vue';

// happy-dom exposes no localStorage here; the settings store only needs getItem/setItem.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => backing.set(key, value),
  removeItem: (key: string) => backing.delete(key),
});

const text = () => document.body.textContent ?? '';
const tab = (label: string) => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((b) => b.textContent?.trim() === label);
const select = (label: string) => document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

/** What an <option> says once the level indentation is stripped off it. */
const optionNames = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent?.replace(/\u00a0/g, '').trim() ?? '');

async function pick(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change'));
  await flushPromises();
}

/**
 * The Storage & uploads section (spec §8) and the assistant's own switch. Filling the folder select used to walk
 * the WHOLE drive — `listFolders`, one request per folder — on every open of the modal, for a list of which two or
 * three entries are ever looked at; it is loaded a level at a time now, like the destination picker.
 */
describe('SettingsModal', () => {
  let wrapper: { unmount: () => void } | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    backing.clear();
    vi.restoreAllMocks();
  });

  async function open() {
    resetMock();
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    const files = useFilesStore();
    await files.bootstrap();
    const folders = vi.spyOn(repository, 'listFolders');
    const level = vi.spyOn(repository, 'listSubfolders');
    wrapper = mount(SettingsModal, { attachTo: document.body, global: { plugins: [i18n] } });
    await flushPromises();
    return { folders, level };
  }

  it('opens without walking the storage tree, and asks for nothing until the panel is looked at', async () => {
    const { folders, level } = await open();
    expect(folders).not.toHaveBeenCalled();
    expect(level).not.toHaveBeenCalled();
  });

  it('fills the folder select a level at a time, one request per level', async () => {
    const { folders, level } = await open();
    tab('Preferences')?.click();
    await flushPromises();
    // One request: what is directly inside the drive root. Not the drive.
    expect(folders).not.toHaveBeenCalled();
    expect(level).toHaveBeenCalledTimes(1);

    const folder = select('Default upload folder')!;
    expect(optionNames(folder)).toEqual(['My files', 'Code', 'Design', 'Documents', 'Photos', 'example', 'Archive', 'Resources', 'Shared']);

    // Picking one drills into it: its own children arrive, and the trail back up stays on offer.
    await pick(folder, 'design');
    expect(level).toHaveBeenCalledTimes(2);
    expect(level.mock.calls.at(-1)).toEqual(['design']);
    expect(optionNames(folder).slice(0, 2)).toEqual(['My files', 'Design']);
    expect(folder.value).toBe('design');

    // And back up to the root: no further level to fetch beyond the one already asked for.
    await pick(folder, '');
    expect(optionNames(folder)).toContain('Code');
  });

  it('offers the Storage & uploads section and the assistant switch the spec names', async () => {
    await open();
    tab('Preferences')?.click();
    await flushPromises();
    expect(text()).toContain('Storage & uploads');
    expect(text()).toContain('Default upload folder');
    expect(text()).toContain('Auto-open preview');
    expect(text()).toContain('Upload conflict behavior');
    expect(optionNames(select('Upload conflict behavior')!)).toEqual(['Ask me what to do', 'Replace the file', 'Keep both files', 'Skip the upload']);

    tab('AI assistant')?.click();
    await flushPromises();
    expect(text()).toContain('Enable AI assistant');
    expect(text()).toContain('Default search mode');
  });

  // ⚠ A node id here IS a path, so renaming the folder leaves a setting naming something that is not there. The
  // select must not show an empty box over a dead id: it falls back to the root, which "Save changes" then commits.
  it('falls back to the drive root when the saved folder is gone', async () => {
    backing.set('filex.app.settings', JSON.stringify({ defaultUploadFolder: 'demo/renamed-away' }));
    await open();
    tab('Preferences')?.click();
    await flushPromises();
    const folder = select('Default upload folder')!;
    expect(folder.value).toBe('');
    expect(optionNames(folder)).toContain('Design');
  });
});
