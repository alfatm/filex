import type { PlanCard, PlanItem } from '@/data/types';

type Translate = (key: string, named?: Record<string, string>) => string;

/** The actions this build has words for; anything else shows its code rather than a missing-translation key. */
const PLAN_ACTIONS = ['tag', 'restore_version', 'create_share', 'revoke_share', 'purge', 'move', 'mkdir'] as const;

/** What one line of a plan does, in the reader's language. */
export function itemAction(item: PlanItem, t: Translate): string {
  if (!(PLAN_ACTIONS as readonly string[]).includes(item.action)) return item.action;
  return t(`assistant.plan.action.${item.action}`, item.args ?? {});
}

/** The plan as plain text for the clipboard: the summary, then one line per item with its full address. */
export function planText(card: PlanCard, t: Translate): string {
  return [card.summary, ...card.items.map((item) => `${item.path} — ${itemAction(item, t)}`)].filter(Boolean).join('\n');
}
