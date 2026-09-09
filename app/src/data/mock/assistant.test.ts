import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantEvent, AssistantMode } from '../types';
import { assistantAsk, parsePrompt, REF_ANSWER, REF_FOLLOW_UP, REF_PROMPT } from './assistant';
import { mockRepository, resetMock } from './index';

const NOW = new Date('2026-09-06T12:00:00');

/** Drains the generator under fake timers: each word waits 30 ms, so the clock is advanced between events. */
async function collect(prompt: string, mode: AssistantMode = 'filename', signal = new AbortController().signal) {
  const events: AssistantEvent[] = [];
  const generator = assistantAsk(prompt, mode, null, signal, NOW);
  for (let next = generator.next(); ; next = generator.next()) {
    await vi.runAllTimersAsync();
    const { value, done } = await next;
    if (done) return events;
    events.push(value);
  }
}

function text(events: AssistantEvent[]) {
  return events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
}

function hitNames(events: AssistantEvent[]) {
  return events.flatMap((e) => (e.type === 'hits' ? e.hits.map((h) => h.node.name) : []));
}

describe('parsePrompt', () => {
  it('extracts "tag: X", months and drops stop words', () => {
    expect(parsePrompt('Search by tag: design')).toEqual({ text: '', tags: ['design'], month: null });
    expect(parsePrompt('Find contracts from July')).toEqual({ text: 'contracts', tags: [], month: 6 });
    expect(parsePrompt('files about the API in september')).toEqual({ text: 'API', tags: [], month: 8 });
    expect(parsePrompt('README')).toEqual({ text: 'README', tags: [], month: null });
  });
});

describe('mock assistantAsk', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    resetMock();
  });

  it('opens with the conversation id, then streams the reference answer word by word, hits, done, follow-up, done', async () => {
    const events = await collect(REF_PROMPT);
    expect(events[0]).toEqual({ type: 'meta', conversationId: 'mock-1' });
    const kinds = events.slice(1).map((e) => e.type);
    const firstHits = kinds.indexOf('hits');
    expect(kinds.slice(0, firstHits).every((k) => k === 'text')).toBe(true);
    expect(firstHits).toBe(REF_ANSWER.split(' ').length);
    expect(kinds.slice(firstHits, firstHits + 2)).toEqual(['hits', 'done']);
    expect(kinds.slice(firstHits + 2).every((k, i, all) => (i === all.length - 1 ? k === 'done' : k === 'text'))).toBe(true);
    expect(text(events)).toBe(REF_ANSWER + REF_FOLLOW_UP);
    const hits = events.find((e) => e.type === 'hits');
    expect(hits?.type === 'hits' && hits.hits.map((h) => [h.node.name, h.folderPath])).toEqual([
      ['overview.pdf', ''],
      ['UI Design.fig', ''],
      ['README.md', ''],
    ]);
  });

  it('answers other prompts from the mock search in the chosen mode', async () => {
    const events = await collect('design', 'content');
    expect(text(events)).toBe('I found 4 matching files.');
    expect(events.at(-1)).toEqual({ type: 'done' });
    const none = await collect('nothing-here');
    expect(text(none)).toBe('I found no matching files.');
    expect(none.some((e) => e.type === 'hits')).toBe(false);
  });

  it('puts every match into one report card when the prompt asks for a report, with no hit cards', async () => {
    const events = await collect('design report', 'content');
    expect(text(events)).toBe('I put 4 files into a report you can download.');
    expect(events.some((e) => e.type === 'hits')).toBe(false);
    const report = events.find((e) => e.type === 'report');
    expect(report?.type === 'report' && [report.report.title, report.report.rows.length]).toEqual(['Files about design', 4]);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('understands the "Search by tag: design" suggestion in Filename mode', async () => {
    const events = await collect('Search by tag: design');
    expect(text(events)).toBe('I found 3 matching files.');
    expect(hitNames(events)).toEqual(['Design', 'overview.pdf', 'beach.png']);
  });

  it('narrows a month name to that month of the current year', async () => {
    // Nothing in the dataset is a contract, so the chip answers honestly; the window alone lists July's files.
    expect(text(await collect('Find contracts from July'))).toBe('I found no matching files.');
    const july = await collect('files from July');
    expect(text(july)).toBe('I found 5 matching files.');
    expect(hitNames(july)).toEqual(['Code', 'Design', 'overview.pdf', 'beach.png', 'README.md']);
    expect(text(await collect('files from March'))).toBe('I found no matching files.');
  });

  it('leaves trashed nodes out of the answer', async () => {
    await mockRepository.moveToTrash(['readme-md']);
    // Only Code/README.md remains.
    const hits = (await collect('README')).flatMap((e) => (e.type === 'hits' ? e.hits.map((h) => [h.node.name, h.folderPath]) : []));
    expect(hits).toEqual([['README.md', 'Code']]);
  });

  it('stops early when aborted', async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    const events: AssistantEvent[] = [];
    for await (const event of assistantAsk(REF_PROMPT, 'filename', null, controller.signal, NOW)) {
      events.push(event);
      if (events.length === 3) controller.abort();
    }
    expect(events.map((e) => e.type)).toEqual(['meta', 'text', 'text']);
  });
});
