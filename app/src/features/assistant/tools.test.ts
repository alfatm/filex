import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import ru from '@/locales/ru.json';
import tr from '@/locales/tr.json';
import { ASSISTANT_TOOLS } from './tools';

const LOCALES = { en, ru, tr } as Record<string, { assistant: { tools: Record<string, string> } }>;

/**
 * The panel names the running tool from `assistant.tools.<name>`. Nine of the sixteen names the server declares had
 * no key at all, so the panel printed "plan_empty_trash main://…" — on the very cards a person reads before
 * approving a plan. This is what stops that coming back one tool at a time.
 */
describe('assistant tool names', () => {
  it.each(Object.keys(LOCALES))('has words for every known tool in %s', (locale) => {
    const tools = LOCALES[locale].assistant.tools;
    expect(ASSISTANT_TOOLS.filter((name) => !tools[name])).toEqual([]);
  });

  // The other direction: a key nobody can reach is a translation paid for and never shown.
  it.each(Object.keys(LOCALES))('has no tool key %s cannot show', (locale) => {
    expect(Object.keys(LOCALES[locale].assistant.tools).sort()).toEqual([...ASSISTANT_TOOLS].sort());
  });
});
