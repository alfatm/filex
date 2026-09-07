import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMock } from '@/data/mock';
import { useFilesStore } from '@/stores/files';
import { UPLOAD_MS, useUploadStore } from './uploadStore';

async function setup() {
  resetMock();
  setActivePinia(createPinia());
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath('');
  return { files, uploads: useUploadStore() };
}

const file = (name: string) => new File(['x'], name);

describe('upload store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes files after UPLOAD_MS and adds them to the open folder', async () => {
    const { files, uploads } = await setup();
    uploads.start([file('a.txt')]);
    expect(uploads.open).toBe(true);
    expect(uploads.doneCount).toBe(0);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS);
    expect(uploads.doneCount).toBe(1);
    expect(files.ordered.map((n) => n.name)).toContain('a.txt');
  });

  it('clear() mid-flight keeps the in-flight upload running and drops finished rows only', async () => {
    const { files, uploads } = await setup();
    uploads.start([file('first.txt')]);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS);
    uploads.start([file('second.txt')]);
    await vi.advanceTimersByTimeAsync(UPLOAD_MS / 2);
    expect(uploads.items.map((i) => i.done)).toEqual([true, false]);

    uploads.clear();
    expect(uploads.items.map((i) => i.name)).toEqual(['second.txt']);
    expect(uploads.open).toBe(true);

    await vi.advanceTimersByTimeAsync(UPLOAD_MS / 2);
    expect(uploads.doneCount).toBe(1);
    expect(files.ordered.map((n) => n.name)).toEqual(expect.arrayContaining(['first.txt', 'second.txt']));
    uploads.clear();
    expect(uploads.open).toBe(false);
  });
});
