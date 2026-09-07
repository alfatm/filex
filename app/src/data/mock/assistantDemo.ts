import { REF_ANSWER, REF_FOLLOW_UP, REF_PROMPT, refHits } from './assistant';
import type { AssistantMessage } from '../types';

const AT = '2026-07-10T10:24:00';

/** The spec §6 conversation, pre-rendered for `?demo=assistant` (screenshots / e2e only). */
export function refConversation(): AssistantMessage[] {
  return [
    { id: 'demo-1', role: 'user', text: REF_PROMPT, at: AT },
    { id: 'demo-2', role: 'assistant', text: REF_ANSWER, at: AT, hits: refHits },
    { id: 'demo-3', role: 'assistant', text: REF_FOLLOW_UP, at: AT },
  ];
}
