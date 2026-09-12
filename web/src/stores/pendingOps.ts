/**
 * pendingOps — admin SPA mirror of the SFC's in-app pending-ops poller.
 *
 * The SFC (`packages/core/src/composables/usePendingOps.ts`) keeps its
 * own poller for the in-explorer toast feedback. This Pinia store is a
 * SIBLING — it powers the bottom-right `PendingOpsTray` mounted at the
 * admin layout level so users see ongoing copy/move/delete progress
 * everywhere in the SPA, not just on the Explore page.
 *
 * How it learns about ops:
 *   - LIVE, over the same WebSocket the explorer already uses. The queue
 *     addresses each frame to the account that submitted the op (see
 *     `internal/ops/live.go`), so the tray hears about a copy on every page,
 *     including the ones that mount no explorer and join no room.
 *   - By POLLING `GET /api/files/ops?status=running` every `POLL_MS`, but
 *     ONLY while the socket is unavailable. This used to run unconditionally
 *     from the moment the layout mounted until the tab was closed — 43 200
 *     requests a day per open tab, essentially all of them answering "nothing
 *     is running". Failure (network/404) keeps the local set unchanged, so an
 *     older backend degrades to exactly the old behaviour.
 *   - Anything we've seen *active* before stays in the local list until
 *     it transitions to a terminal state OR the row disappears from
 *     two consecutive polls (probably purged server-side).
 *   - Terminal ops linger for `RETAIN_MS` so the user sees the final
 *     state, then fade out. Failed ops stick around with a Retry button
 *     until manually dismissed.
 *   - Embedders can also call `track(opId)` after kicking an op manually
 *     (e.g. from a hand-rolled paste flow); the store will then poll
 *     `GET /api/files/ops/{id}` for that row even if the list endpoint
 *     is missing.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { RealtimeClient, type OpMessage } from '@brftech/filex-core';
import { api } from '@/api/client';
import { opsApi, normalizeOp, type PendingOp } from '@/api/ops';

const POLL_MS = 2_000;
const RETAIN_MS = 3_000;

interface TrayItem {
  op: PendingOp;
  /** Wall-clock when the op flipped to a terminal state (done|error). */
  settledAt: number | null;
  /** True once the op has been cancelled by the user. */
  cancelled?: boolean;
  /** Polls in a row where we saw the op missing from the list. */
  missCount: number;
}

function isTerminal(s: PendingOp['status']): boolean {
  return s === 'done' || s === 'error';
}

export const usePendingOpsStore = defineStore('pending-ops', () => {
  const items = ref<TrayItem[]>([]);
  const polling = ref(false);
  const lastError = ref<string | null>(null);
  // Set of op IDs the embedder has explicitly asked us to track. We
  // poll these one-by-one as a backup when the list endpoint is missing.
  const tracked = ref<Set<number>>(new Set());

  /** True while the live socket is carrying op frames. */
  const live = ref(false);

  let timer: ReturnType<typeof setInterval> | null = null;
  let client: RealtimeClient | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  const list = computed<PendingOp[]>(() => items.value.map((it) => it.op));
  const active = computed(() => list.value.filter((o) => !isTerminal(o.status)));
  const hasActive = computed(() => active.value.length > 0);
  const visible = computed(() => items.value.length > 0);

  function start(): void {
    if (timer) return;
    polling.value = true;
    timer = setInterval(() => {
      void poll();
    }, POLL_MS);
    void poll();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    polling.value = false;
  }

  /**
   * connect opens the live channel and brings the tray up to date once.
   *
   * The single poll is not a fallback — it is the BACKLOG: an op submitted
   * before this tab existed (another tab, another device, a page reload during
   * a long copy) has already sent its frames to sockets that are now gone, and
   * nothing will re-send them. After that one answer the socket carries
   * everything, and no timer runs while the queue is idle.
   */
  function connect(): void {
    void poll();
    if (client) return;
    client = new RealtimeClient({
      getTicket: async () => {
        try {
          const { data } = await api.post<{ ticket: string; ws_url: string }>('/files/ws-ticket');
          return data?.ticket && data?.ws_url ? data : null;
        } catch {
          // No ticket → no socket → onFallback(true) below puts us on the poll.
          return null;
        }
      },
      handlers: {
        onOp: (msg: OpMessage) => applyLive(msg),
        onStatus: (connected: boolean) => {
          live.value = connected;
          if (!connected) return;
          stop();
          // Frames sent while the socket was down reached nobody, so a
          // reconnect re-reads the backlog exactly as the first connect did.
          void poll();
        },
        // Fires only once the client has given up reconnecting. THIS is the
        // one thing that starts the interval — the tray would otherwise go
        // blind in the middle of a copy.
        onFallback: (active: boolean) => {
          if (active) start();
        },
      },
    });
  }

  /** Tear down the live channel and every timer. Call on unmount. */
  function disconnect(): void {
    client?.close();
    client = null;
    live.value = false;
    stop();
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
  }

  /**
   * applyLive folds one server frame into the tray.
   *
   * The frame carries the raw `ops.Op` row, which is the same shape the list
   * endpoint returns — `normalizeOp` is therefore the one translation, shared
   * with the poll, and a row cannot render differently depending on how it
   * arrived.
   */
  function applyLive(msg: OpMessage): void {
    if (!msg?.op) return;
    const op = normalizeOp(msg.op as unknown as Record<string, unknown>);
    if (!op.id) return;
    upsert(op);
    if (isTerminal(op.status)) {
      tracked.value.delete(op.id);
      scheduleSweep();
    }
  }

  /**
   * scheduleSweep retires finished rows after `RETAIN_MS`.
   *
   * The poll used to do this on its next tick, which is why removing the poll
   * needs this: without it a completed op would sit in the tray until the user
   * navigated away. It arms at most one timer, and only while something
   * finished is on screen — an idle tray schedules nothing.
   */
  function scheduleSweep(): void {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      const now = Date.now();
      items.value = items.value.filter((it) => {
        if (it.cancelled) return now - (it.settledAt ?? now) < RETAIN_MS;
        if (!isTerminal(it.op.status)) return true;
        // Failed ops stick until dismissed; done ops fade out.
        if (it.op.status === 'error') return true;
        return now - (it.settledAt ?? now) < RETAIN_MS;
      });
      if (items.value.some((it) => isTerminal(it.op.status) || it.cancelled)) scheduleSweep();
    }, RETAIN_MS);
  }

  function upsert(op: PendingOp): void {
    const i = items.value.findIndex((it) => it.op.id === op.id);
    if (i === -1) {
      items.value = [
        ...items.value,
        {
          op,
          settledAt: isTerminal(op.status) ? Date.now() : null,
          missCount: 0,
        },
      ];
      return;
    }
    const prev = items.value[i];
    const wasTerminal = isTerminal(prev.op.status);
    const nowTerminal = isTerminal(op.status);
    const settledAt = wasTerminal ? prev.settledAt : nowTerminal ? Date.now() : null;
    items.value = items.value.map((it, idx) =>
      idx === i ? { op, settledAt, cancelled: prev.cancelled, missCount: 0 } : it,
    );
  }

  async function poll(): Promise<void> {
    try {
      const incoming = await opsApi.list({ status: 'running' });
      lastError.value = null;
      const seen = new Set<number>();
      for (const op of incoming) {
        seen.add(op.id);
        upsert(op);
      }

      // Ops we were tracking but didn't see in the list — fetch each
      // individually. Catches non-running statuses + the no-list-endpoint
      // case where `incoming` is always [].
      const missingTracked: number[] = [];
      for (const id of tracked.value) {
        if (seen.has(id)) continue;
        missingTracked.push(id);
      }
      if (missingTracked.length) {
        const fetched = await Promise.allSettled(missingTracked.map((id) => opsApi.get(id)));
        fetched.forEach((r, idx) => {
          if (r.status === 'fulfilled' && r.value) {
            upsert(r.value);
            if (isTerminal(r.value.status)) tracked.value.delete(missingTracked[idx]);
          }
        });
      }

      // Bump miss counters for known-active rows that didn't show up.
      // Two strikes and we drop them — the server has likely purged the
      // row (which means the op completed before we saw it again).
      const now = Date.now();
      const updated = items.value
        .map((it) => {
          if (isTerminal(it.op.status)) return it;
          if (seen.has(it.op.id) || tracked.value.has(it.op.id)) return it;
          return { ...it, missCount: it.missCount + 1 };
        })
        // Sweep terminal rows past RETAIN_MS, and also drop active rows
        // that have missed two consecutive polls.
        .filter((it) => {
          if (it.cancelled) return now - (it.settledAt ?? now) < RETAIN_MS;
          if (isTerminal(it.op.status)) {
            // Failed ops stick until dismissed; done ops fade out.
            if (it.op.status === 'error') return true;
            return now - (it.settledAt ?? now) < RETAIN_MS;
          }
          return it.missCount < 2;
        });
      items.value = updated;
    } catch (e: unknown) {
      lastError.value = (e as Error).message ?? 'poll failed';
    }
  }

  /**
   * Mark this op for individual polling — needed when the list endpoint isn't
   * available, or when a hand-rolled flow kicked an op the tray hasn't seen.
   *
   * On a live socket the op's own frames are already on their way, so this
   * only fetches the row once for an immediate render; the interval stays off.
   */
  function track(opId: number): void {
    if (!Number.isFinite(opId) || opId <= 0) return;
    tracked.value.add(opId);
    if (live.value) void poll();
    else start();
  }

  function dismiss(opId: number): void {
    items.value = items.value.filter((it) => it.op.id !== opId);
    tracked.value.delete(opId);
    // Nothing left to draw: the fallback interval has no reason to run. The
    // socket stays — it costs nothing idle and is how the next op arrives.
    if (items.value.length === 0) stop();
  }

  function clear(): void {
    items.value = [];
    tracked.value.clear();
    stop();
  }

  /**
   * Best-effort cancel — flags the op locally as cancelled. The backend
   * doesn't expose a cancel endpoint for ops yet, so we just hide the
   * row; the worker will continue running until completion. Surface the
   * UX honestly (button label clarifies "hide" vs "cancel" upstream).
   */
  function cancel(opId: number): void {
    const i = items.value.findIndex((it) => it.op.id === opId);
    if (i === -1) return;
    items.value = items.value.map((it, idx) =>
      idx === i ? { ...it, cancelled: true, settledAt: Date.now() } : it,
    );
  }

  /** Retry — re-track the op for a per-id poll. */
  async function retry(opId: number): Promise<void> {
    track(opId);
    const op = await opsApi.get(opId);
    if (op) upsert(op);
  }

  return {
    items,
    list,
    active,
    hasActive,
    visible,
    polling,
    live,
    lastError,
    connect,
    disconnect,
    start,
    stop,
    poll,
    track,
    dismiss,
    cancel,
    clear,
    retry,
  };
});
