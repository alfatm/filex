import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { FileLimitExceeded, UploadConflict, UploadRateLimited } from '@/data/repository';
import type { Node, UploadInput, UploadOptions } from '@/data/types';
import { useSettingsStore, type ConflictBehavior } from '@/features/settings/settingsStore';
import { useFilesStore } from '@/stores/files';
import { RETRY_DELAY_MS, useUploadStore } from './uploadStore';

const FOLDER = 'main://Docs';
const landed = (name: string): Node => ({ id: `${FOLDER}/${name}`, name, kind: 'file', parentId: FOLDER, size: 3, ownerId: 'u1', shared: false, starred: false });
const file = (name: string) => new File(['abc'], name);

/**
 * The fake server: `plan` answers each attempt at a name with the node that landed or the refusal. A refusal at
 * commit hands the session over first, as the real path does — the bytes are staged by then.
 */
function stubUploads(plan: (name: string, options: UploadOptions | undefined, attempt: number) => Node | Error) {
  const attempts = new Map<string, number>();
  return vi.spyOn(repository, 'uploadFile').mockImplementation(async (_parent: string, input: UploadInput, options?: UploadOptions) => {
    const attempt = (attempts.get(input.name) ?? 0) + 1;
    attempts.set(input.name, attempt);
    const outcome = plan(input.name, options, attempt);
    if (outcome instanceof Error) {
      if (outcome instanceof UploadConflict && outcome.sessionId) options?.onSession?.(outcome.sessionId);
      throw outcome;
    }
    return outcome;
  });
}

const exists = (phase: 'begin' | 'commit', sessionId: string | null = null) => new UploadConflict('exists', phase, sessionId);

describe('upload conflicts, decided by the server', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(repository, 'listFolder').mockResolvedValue({ nodes: [landed('a.txt'), landed('a-copy.txt')], total: 2 });
    vi.spyOn(repository, 'abortUpload').mockResolvedValue();
    vi.spyOn(repository, 'commitUpload').mockImplementation(async (_id, _parent, name) => landed(name));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function rule(behavior: ConflictBehavior) {
    useSettingsStore().settings.conflictBehavior = behavior;
  }

  it('sends "replace" with every transfer under the replace rule, and asks nobody anything', async () => {
    rule('replace');
    const upload = stubUploads((name) => landed(name));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][2]).toMatchObject({ ifExists: 'replace' });
    expect(repository.listFolder).not.toHaveBeenCalled();
    expect(uploads.items[0].state).toBe('done');
  });

  it('skips a row the server refuses for its name under the skip rule', async () => {
    rule('skip');
    const upload = stubUploads(() => exists('begin'));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(upload.mock.calls[0][2]).toMatchObject({ ifExists: 'fail' });
    expect(uploads.items[0].state).toBe('skipped');
    expect(uploads.pendingConflict).toBeNull();
    expect(uploads.pendingCount).toBe(0);
  });

  it('retries under a free name after a refusal at begin under the keep-both rule', async () => {
    rule('keepBoth');
    const upload = stubUploads((name, _options, attempt) => (attempt === 1 && name === 'a.txt' ? exists('begin') : landed(name)));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    // `a-copy.txt` is taken according to the listing, so the next free name is the one sent.
    expect(upload.mock.calls.map((c) => c[1].name)).toEqual(['a.txt', 'a-copy-2.txt']);
    expect(uploads.items[0]).toMatchObject({ name: 'a-copy-2.txt', state: 'done' });
    // The folder was listed once, and only to find that name.
    expect(repository.listFolder).toHaveBeenCalledTimes(1);
  });

  it('asks, and a Replace after a refusal at begin uploads again with "replace"', async () => {
    rule('ask');
    const upload = stubUploads((name, options) => (options?.ifExists === 'fail' ? exists('begin') : landed(name)));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(uploads.pendingConflict).toMatchObject({ name: 'a.txt', state: 'conflict', conflict: 'exists' });

    uploads.decide(uploads.pendingConflict!.id, 'replace');
    await flushPromises();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][2]).toMatchObject({ ifExists: 'replace' });
    expect(uploads.items[0].state).toBe('done');
    expect(uploads.pendingConflict).toBeNull();
  });

  it('finishes the staged session after a refusal at commit — no second upload', async () => {
    rule('ask');
    const upload = stubUploads(() => exists('commit', 's1'));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(uploads.pendingConflict).toMatchObject({ conflict: 'exists', sessionId: 's1' });

    uploads.decide(uploads.pendingConflict!.id, 'replace');
    await flushPromises();
    expect(repository.commitUpload).toHaveBeenCalledWith('s1', FOLDER, 'a.txt', expect.objectContaining({ ifExists: 'replace' }));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploads.items[0].state).toBe('done');
  });

  it('drops the staged session when Skip answers a refusal at commit', async () => {
    rule('ask');
    stubUploads(() => exists('commit', 's2'));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    uploads.decide(uploads.pendingConflict!.id, 'skip');
    await flushPromises();
    expect(uploads.items[0].state).toBe('skipped');
    expect(repository.abortUpload).toHaveBeenCalledWith('s2');
  });

  it('asks about a target somebody else is uploading to, and Retry sends the row again after a pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rule('replace');
    const upload = stubUploads((name, _options, attempt) => (attempt === 1 ? new UploadConflict('inProgress', 'begin', null) : landed(name)));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(uploads.pendingConflict).toMatchObject({ conflict: 'inProgress' });

    uploads.decide(uploads.pendingConflict!.id, 'retry');
    await flushPromises();
    // Re-queued, not re-sent: the server holds the target for a while after the other session's last chunk.
    expect(uploads.items[0].state).toBe('queued');
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await flushPromises();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(uploads.items[0].state).toBe('done');
  });

  // Nothing about the row is wrong and nobody has a decision to make: the window is full and will free up. So it
  // is neither a question nor a failure — the row says how long, and goes out again by itself.
  it('waits out a full upload window and sends the row again, saying how long in minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rule('replace');
    const upload = stubUploads((name, _options, attempt) => (attempt === 1 ? new UploadRateLimited(720) : landed(name)));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();

    expect(uploads.items[0].state).toBe('queued');
    expect(uploads.items[0].error).toBe('Upload limit reached · try again in 12 min');
    expect(upload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(720_000);
    await flushPromises();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(uploads.items[0].state).toBe('done');
    expect(uploads.items[0].error).toBeUndefined();
  });

  /*
   * But it waits ONCE. The server answers with the whole window when the request is larger than the window's
   * entire allowance, so a second refusal proves that waiting is not the answer: a 2 GB file under a 1 GB/24 h
   * rule used to wait a day, be refused, and wait another — for ever, with the batch's promise held open behind
   * it, so the listing was never re-read either.
   */
  it('fails a row the window refuses twice instead of waiting again, and lets the batch finish', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rule('replace');
    const landing = vi.spyOn(useFilesStore(), 'uploadsLanded').mockResolvedValue();
    const upload = stubUploads(() => new UploadRateLimited(720));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(uploads.items[0].state).toBe('queued');
    expect(landing).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(720_000);
    await flushPromises();
    expect(upload).toHaveBeenCalledTimes(2);
    // The wording stays the same: the person can send it again by hand, which is the only thing left to try.
    expect(uploads.items[0].state).toBe('failed');
    expect(uploads.items[0].error).toBe('Upload limit reached · try again in 12 min');
    expect(uploads.pendingCount).toBe(0);
    // The batch is over, so the listing is re-read — it used to hang on the row for ever.
    expect(landing).toHaveBeenCalledTimes(1);

    // And nothing goes out again on its own after that.
    await vi.advanceTimersByTimeAsync(720_000 * 3);
    await flushPromises();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  // Cancelling a row that is waiting on a clock has to release the batch too; the row's state alone left the
  // batch's promise pending for the whole wait.
  it('settles the batch at once when a waiting row is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rule('replace');
    const landing = vi.spyOn(useFilesStore(), 'uploadsLanded').mockResolvedValue();
    stubUploads(() => new UploadRateLimited(720));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(uploads.items[0].state).toBe('queued');

    await uploads.cancel(uploads.items[0].id);
    await flushPromises();
    expect(uploads.items[0].state).toBe('cancelled');
    // Without advancing the clock by a single tick of the 12 minutes the row was waiting out.
    expect(landing).toHaveBeenCalledTimes(1);
  });

  // A row waiting on a PERSON, not a clock. Cancelling it takes the modal off the screen (it is drawn from
  // `pendingConflict`, which looks for state 'conflict'), so no answer is ever coming — and the batch used to stay
  // pending for the rest of the session, with the listing never told the uploads were over.
  it('settles the batch when the person cancels the row the question was about', async () => {
    rule('ask');
    const landing = vi.spyOn(useFilesStore(), 'uploadsLanded').mockResolvedValue();
    stubUploads(() => new UploadConflict('exists', 'begin', null));
    const uploads = useUploadStore();
    const batch = uploads.start([file('a.txt')], FOLDER);
    await flushPromises();
    expect(uploads.pendingConflict?.name).toBe('a.txt');

    await uploads.cancel(uploads.items[0].id);
    await batch;
    expect(uploads.items[0].state).toBe('cancelled');
    expect(uploads.pendingConflict).toBeNull();
    expect(landing).toHaveBeenCalledTimes(1);

    // And the answer that can no longer arrive does nothing if it does.
    uploads.decide(uploads.items[0].id, 'replace');
    await flushPromises();
    expect(uploads.items[0].state).toBe('cancelled');
  });

  // The other ceiling is not a matter of waiting, so the row fails — and names the limit, because "Upload failed"
  // sends the person looking for a network problem.
  it('fails a row that met the file ceiling, and says which ceiling it was', async () => {
    rule('replace');
    stubUploads(() => new FileLimitExceeded(5000, 5000));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt')], FOLDER);
    await flushPromises();

    expect(uploads.items[0].state).toBe('failed');
    expect(uploads.items[0].error).toBe('File limit reached (5,000)');
  });

  it('gives the same answer to the rest of the batch when asked to, without a second question', async () => {
    rule('ask');
    const upload = stubUploads((name, options) => (options?.ifExists === 'fail' ? exists('begin') : landed(name)));
    const uploads = useUploadStore();
    await uploads.start([file('a.txt'), file('b.txt')], FOLDER);
    await flushPromises();
    // Both refused; one question at a time, about the first.
    expect(uploads.items.map((i) => i.state)).toEqual(['conflict', 'conflict']);
    expect(uploads.pendingConflict?.name).toBe('a.txt');

    uploads.decide(uploads.pendingConflict!.id, 'replace', { applyToAll: true });
    await flushPromises();
    expect(uploads.pendingConflict).toBeNull();
    expect(uploads.items.map((i) => i.state)).toEqual(['done', 'done']);
    expect(upload.mock.calls.filter((c) => c[2]?.ifExists === 'replace').map((c) => c[1].name).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
