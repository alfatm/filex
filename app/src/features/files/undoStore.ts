import { defineStore } from 'pinia';
import { computed, ref, type Ref } from 'vue';

/** An action that can be taken back and put back: the two directions of the same step. */
export interface HistoryStep {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/**
 * One step back, one step forward. Ctrl+Z and the "Undo" button of the trash toast run the same record, so the two
 * can never fire it twice between them; Ctrl+Shift+Z puts that step back.
 *
 * The depth is deliberately one. A longer history would have to address nodes that later actions may have renamed,
 * moved or deleted — and with paths for ids, a stale step does not fail loudly, it acts on whatever now answers to
 * that path. One step is the depth this can keep honest.
 *
 * `files.mutate` clears the record before every mutation, so an action that cannot be undone (delete for good,
 * empty trash, restore) leaves nothing armed rather than leaving the previous action's inverse behind. A new action
 * also drops the forward step: what was undone can no longer be put back on top of something else.
 */
export const useUndoStore = defineStore('undo', () => {
  const back = ref<HistoryStep | null>(null);
  const forward = ref<HistoryStep | null>(null);
  const canUndo = computed(() => back.value !== null);
  const canRedo = computed(() => forward.value !== null);

  /** True while a step is being replayed: its own mutations are that step, not new actions to remember. */
  let replaying = false;

  function record(step: HistoryStep) {
    if (replaying) return;
    back.value = step;
    forward.value = null;
  }

  function clear() {
    if (replaying) return;
    back.value = null;
    forward.value = null;
  }

  /** Arms the opposite direction only once the step has actually run, and only if it did not throw. */
  async function replay(step: HistoryStep, direction: 'undo' | 'redo', arm: Ref<HistoryStep | null>) {
    // Both directions are dropped before the step runs, so a step that FAILED would leave the history empty and
    // the action unreachable for good. What was armed is therefore kept and put back when it does not happen.
    const armed = { back: back.value, forward: forward.value };
    back.value = null;
    forward.value = null;
    replaying = true;
    try {
      await step[direction]();
    } catch (error) {
      back.value = armed.back;
      forward.value = armed.forward;
      throw error;
    } finally {
      replaying = false;
    }
    arm.value = step;
  }

  async function undo() {
    const step = back.value;
    if (step) await replay(step, 'undo', forward);
  }

  async function redo() {
    const step = forward.value;
    if (step) await replay(step, 'redo', back);
  }

  return { canUndo, canRedo, record, clear, undo, redo };
});
