import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { OPERATION_PENDING, ROLE_FORBIDDEN } from '@/data/repository';
import { i18n } from '@/i18n';

/**
 * `running` — the request is in flight.
 * `pending` — the server took the work and is still doing it; the app stopped waiting for an answer.
 * `failed`  — it did not happen, and `error` is what the server said.
 */
export type OperationState = 'running' | 'pending' | 'failed';

export interface Operation {
  id: number;
  label: string;
  state: OperationState;
  error?: string;
  /**
   * A row is drawn only once it has been running long enough to be worth mentioning, or the moment it stops going
   * well. Without that the tray would flash open for every rename that took forty milliseconds.
   */
  visible: boolean;
}

/** How long an operation may run before the tray admits it exists. */
export const OPERATION_VISIBLE_MS = 600;

export const useOperationsStore = defineStore('operations', () => {
  const items = ref<Operation[]>([]);
  const shown = computed(() => items.value.filter((o) => o.visible));
  const open = computed(() => shown.value.length > 0);
  const failedCount = computed(() => shown.value.filter((o) => o.state === 'failed').length);
  let seq = 0;

  /**
   * Runs one mutation and owns what becomes of it.
   *
   * It does not rethrow. Every caller of these verbs was a `void files.move(…)` or an unawaited click handler, so
   * a rejection reached nobody at all: a move that failed produced no toast, no row, no message — the listing
   * simply stayed as it was and the user had to notice. The failure lives here instead, on screen, until dismissed.
   *
   * `landed` runs only when the work is actually done, which is why it is a callback rather than the code after
   * the await: an operation the server is still chewing on must not arm an Undo for half of itself.
   */
  async function run(label: string, action: () => Promise<void>, landed?: () => void): Promise<void> {
    const id = ++seq;
    items.value.push({ id, label, state: 'running', visible: false });
    const reveal = setTimeout(() => {
      const op = items.value.find((o) => o.id === id);
      if (op) op.visible = true;
    }, OPERATION_VISIBLE_MS);
    try {
      await action();
    } catch (e) {
      clearTimeout(reveal);
      const op = items.value.find((o) => o.id === id);
      if (!op) return;
      op.visible = true;
      if (e instanceof Error && e.message === OPERATION_PENDING) {
        op.state = 'pending';
        return;
      }
      op.state = 'failed';
      const message = e instanceof Error ? e.message : String(e);
      // A sentinel is not a sentence: the tray row would otherwise read "roleForbidden".
      op.error = message === ROLE_FORBIDDEN ? i18n.global.t('common.notAllowed') : message;
      return;
    }
    clearTimeout(reveal);
    // Success is not news: the row goes, and the listing already shows what happened.
    dismiss(id);
    landed?.();
  }

  function dismiss(id: number) {
    items.value = items.value.filter((o) => o.id !== id);
  }

  function clear() {
    items.value = [];
  }

  return { items, shown, open, failedCount, run, dismiss, clear };
});
