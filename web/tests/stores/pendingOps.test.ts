// Tests for src/stores/pendingOps.ts.
//
// The bug these lock down: the tray polled `GET /api/files/ops` every 2 s from
// the moment the admin layout mounted until the tab was closed, whether or not
// anything was running — 43 200 requests a day per open tab. The queue now
// pushes its state over the existing WebSocket, and the interval is reserved
// for the case where that socket is unavailable.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

/**
 * The fake socket: tests drive connect/disconnect and frames by hand.
 *
 * Declared through vi.hoisted because vi.mock is lifted above the imports, and
 * a factory closing over an ordinary top-level binding reads it before it
 * exists.
 */
const { sockets, FakeRealtime } = vi.hoisted(() => {
  type Handlers = {
    onStatus?: (connected: boolean) => void;
    onFallback?: (active: boolean) => void;
    onOp?: (msg: unknown) => void;
  };
  const created: FakeSocket[] = [];
  class FakeSocket {
    handlers: Handlers;
    closed = false;
    constructor(opts: { handlers: Handlers }) {
      this.handlers = opts.handlers;
      created.push(this);
    }
    close(): void {
      this.closed = true;
    }
    /** Pretend the socket opened (what RealtimeClient reports via onStatus). */
    open(): void {
      this.handlers.onStatus?.(true);
    }
    /** Pretend the client gave up reconnecting. */
    giveUp(): void {
      this.handlers.onFallback?.(true);
    }
    emitOp(op: Record<string, unknown>): void {
      this.handlers.onOp?.({ type: 'op', op });
    }
  }
  return { sockets: created, FakeRealtime: FakeSocket };
});

vi.mock('@brftech/filex-core', () => ({ RealtimeClient: FakeRealtime }));

const listMock = vi.fn();
const getMock = vi.fn();
vi.mock('@/api/ops', async () => {
  const actual = await vi.importActual<typeof import('@/api/ops')>('@/api/ops');
  return {
    ...actual,
    opsApi: {
      list: (...args: unknown[]) => listMock(...args),
      get: (...args: unknown[]) => getMock(...args),
    },
  };
});

vi.mock('@/api/client', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: { ticket: 't', ws_url: 'ws://x/api/ws' } }) },
}));

import { usePendingOpsStore } from '@/stores/pendingOps';

/** A raw queue row as the server sends it, live or in the list. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 1, kind: 'copy', status: 'running', total: 4, done: 1, sources: ['a'], ...over };
}

describe('stores/pendingOps', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sockets.length = 0;
    listMock.mockResolvedValue([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect() reads the backlog once and then leaves the network alone', async () => {
    const store = usePendingOpsStore();
    store.connect();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);

    // The one backlog read, plus the one a successful connect repeats.
    const afterConnect = listMock.mock.calls.length;
    expect(afterConnect).toBeGreaterThan(0);
    expect(store.polling).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(listMock.mock.calls.length).toBe(afterConnect);
  });

  it('renders an op from a live frame without asking the server', async () => {
    const store = usePendingOpsStore();
    store.connect();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    listMock.mockClear();

    sockets[0].emitOp(row({ id: 7, done: 2 }));

    expect(store.list).toHaveLength(1);
    expect(store.list[0].id).toBe(7);
    expect(store.list[0].progress_done).toBe(2);
    expect(store.hasActive).toBe(true);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('retires a finished op after the retain window, with no poll to do it', async () => {
    const store = usePendingOpsStore();
    store.connect();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);

    sockets[0].emitOp(row({ id: 7, status: 'running' }));
    sockets[0].emitOp(row({ id: 7, status: 'ok', done: 4 }));
    expect(store.list[0].status).toBe('done');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.list).toHaveLength(0);
  });

  it('keeps a failed op on screen until it is dismissed', async () => {
    const store = usePendingOpsStore();
    store.connect();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);

    sockets[0].emitOp(row({ id: 8, status: 'failed', error: 'storage offline' }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.list).toHaveLength(1);
    expect(store.list[0].error_message).toBe('storage offline');

    store.dismiss(8);
    expect(store.list).toHaveLength(0);
  });

  it('falls back to the interval only once the socket gives up', async () => {
    const store = usePendingOpsStore();
    store.connect();
    await vi.advanceTimersByTimeAsync(0);
    listMock.mockClear();

    expect(store.polling).toBe(false);
    sockets[0].giveUp();
    expect(store.polling).toBe(true);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(listMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops the fallback interval when the socket comes back', async () => {
    const store = usePendingOpsStore();
    store.connect();
    sockets[0].giveUp();
    expect(store.polling).toBe(true);

    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    listMock.mockClear();

    expect(store.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('disconnect() closes the socket and leaves no timer running', async () => {
    const store = usePendingOpsStore();
    store.connect();
    sockets[0].giveUp();
    await vi.advanceTimersByTimeAsync(0);
    store.disconnect();
    listMock.mockClear();

    expect(sockets[0].closed).toBe(true);
    expect(store.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listMock).not.toHaveBeenCalled();
  });
});
