import type { AssistantEvent, AssistantMode, SearchHit, SearchQuery, SearchScope } from '../types';
import { nodes } from './dataset';
import { search } from './search';

const WORD_DELAY_MS = 30;
const MAX_HITS = 5;
/** The mock keeps no context; one fixed id proves the store echoes it back. */
const CONVERSATION_ID = 'mock-1';

/** Filler the suggestion chips and natural prompts carry; the remaining words are the search terms. */
const STOP_WORDS = new Set(['find', 'files', 'file', 'search', 'by', 'about', 'from', 'the', 'in', 'for']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** The reference conversation (spec §6). */
export const REF_PROMPT = 'Find files about design guidelines';
export const REF_ANSWER = 'I found 3 matching files based on filename and content.';
export const REF_FOLLOW_UP = "Is there anything else you'd like to search for?";

function refHit(id: string, text: string): SearchHit {
  return { node: nodes.find((n) => n.id === id)!, storageId: 'demo', folderPath: '', snippet: { text, ranges: [] } };
}

export const refHits: SearchHit[] = [
  refHit('overview-pdf', 'Matched content: “brand assets and design guidelines”'),
  refHit('ui-design-fig', 'Matched filename and content: design guidelines, UI design'),
  refHit('readme-md', 'Matched content: “design system”'),
];

/** A prompt that asks for a report gets every match as a downloadable card, not five cards in the chat. */
const REPORT_WORDS = /\b(report|отч[её]т|rapor)\b/i;

const SCOPE_BY_MODE: Record<AssistantMode, SearchScope> = { filename: 'paths', content: 'content', tags: 'tags' };

interface ParsedPrompt {
  text: string;
  tags: string[];
  /** Zero-based month named in the prompt, matched against `modifiedAt` in the current year. */
  month: number | null;
}

/** "Search by tag: design" → tag filter; "Find contracts from July" → term "contracts" within July. */
export function parsePrompt(prompt: string): ParsedPrompt {
  const tags: string[] = [];
  let rest = prompt.replace(/\btag:\s*(\S+)/gi, (_, tag: string) => {
    tags.push(tag);
    return ' ';
  });
  let month: number | null = null;
  rest = rest.replace(/\b([a-z]+)\b/gi, (word) => {
    const at = MONTHS.indexOf(word.toLowerCase());
    if (at === -1) return word;
    month = at;
    return ' ';
  });
  const text = rest
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word.toLowerCase()))
    .join(' ');
  return { text, tags, month };
}

/** Every storage, no filters beyond the parsed tags: the prompt words and the mode narrow the result. */
function promptQuery(parsed: ParsedPrompt, mode: AssistantMode): SearchQuery {
  return {
    text: parsed.text,
    scope: SCOPE_BY_MODE[mode],
    searchIn: 'all',
    folderPath: '',
    modified: 'any',
    fileType: 'any',
    tags: parsed.tags,
    ownerId: null,
    size: { preset: 'any', min: null, max: null, unit: 'MB' },
    path: '',
    wholePhrase: false,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function* words(text: string, signal: AbortSignal): AsyncGenerator<AssistantEvent> {
  const parts = text.split(' ');
  for (const [i, word] of parts.entries()) {
    if (signal.aborted) return;
    yield { type: 'text', delta: i < parts.length - 1 ? `${word} ` : word };
    await sleep(WORD_DELAY_MS, signal);
  }
}

function inMonth(hit: SearchHit, month: number, now: Date): boolean {
  const at = new Date(hit.node.modifiedAt ?? 0);
  return at.getFullYear() === now.getFullYear() && at.getMonth() === month;
}

export async function* assistantAsk(
  prompt: string,
  mode: AssistantMode,
  _conversationId: string | null,
  signal: AbortSignal,
  now = new Date(),
): AsyncGenerator<AssistantEvent> {
  yield { type: 'meta', conversationId: CONVERSATION_ID };
  if (prompt.trim().toLowerCase() === REF_PROMPT.toLowerCase()) {
    yield* words(REF_ANSWER, signal);
    if (signal.aborted) return;
    yield { type: 'hits', hits: refHits };
    yield { type: 'done' };
    yield* words(REF_FOLLOW_UP, signal);
    if (signal.aborted) return;
    yield { type: 'done' };
    return;
  }
  const asReport = REPORT_WORDS.test(prompt);
  const parsed = parsePrompt(asReport ? prompt.replace(REPORT_WORDS, ' ') : prompt);
  const month = parsed.month;
  const found = search(promptQuery(parsed, mode)).hits;
  const matched = month === null ? found : found.filter((hit) => inMonth(hit, month, now));
  if (asReport) {
    yield* words(matched.length ? `I put ${matched.length} ${matched.length === 1 ? 'file' : 'files'} into a report you can download.` : 'I found nothing to report.', signal);
    if (signal.aborted) return;
    if (matched.length) yield { type: 'report', report: { title: parsed.text ? `Files about ${parsed.text}` : 'All files', rows: matched } };
    yield { type: 'done' };
    return;
  }
  const hits = matched.slice(0, MAX_HITS);
  yield* words(hits.length ? `I found ${hits.length} matching ${hits.length === 1 ? 'file' : 'files'}.` : 'I found no matching files.', signal);
  if (signal.aborted) return;
  if (hits.length) yield { type: 'hits', hits };
  yield { type: 'done' };
}
