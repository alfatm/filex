import type { LocationQuery } from 'vue-router';
import { fromWindowQuery, toWindowQuery } from '@/data/dateWindow';
import { FILE_TYPE_GROUPS, MODIFIED_PRESETS, SIZE_PRESETS, type ListingFilter } from '@/data/types';
import { emptyFilter } from './filters';

/**
 * The filter chips as part of the listing's address, the way `/search?q=…` carries the advanced search.
 *
 * The chips are state a person set on purpose, and losing them to a reload is losing work — but a second, hidden
 * copy in storage would be worse: the filter would come back tomorrow on a folder nobody remembered narrowing, with
 * nothing in the address to explain it. In the URL it is visible, shareable, and the browser's Back button takes it
 * off, which is the gesture people already expect.
 *
 * The name box is deliberately NOT here: it is cleared on every navigation by design (see the files store), and
 * putting it in the address would be a second answer to when it survives.
 */
export function toFilterQuery(filter: ListingFilter): Record<string, string | string[]> {
  const neutral = emptyFilter();
  const out: Record<string, string | string[]> = {};
  if (filter.fileType !== neutral.fileType) out.type = filter.fileType;
  if (filter.modified !== neutral.modified) out.modified = filter.modified;
  if (filter.size !== neutral.size) out.size = filter.size;
  if (filter.personId) out.owner = filter.personId;
  if (filter.mime) out.mime = filter.mime;
  // `tags`, the spelling the advanced search has always used: one vocabulary for one question, whichever screen
  // asks it. The window travels as the three parts `dateWindow` defines.
  if (filter.tags.length) out.tags = [...filter.tags];
  return { ...out, ...toWindowQuery(filter.around) };
}

/** The reverse. Anything unreadable — a mistyped preset, half a date window — reads as "not set". */
export function fromFilterQuery(raw: LocationQuery): ListingFilter {
  const neutral = emptyFilter();
  return {
    ...neutral,
    fileType: pick(first(raw.type), FILE_TYPE_GROUPS, neutral.fileType),
    modified: pick(first(raw.modified), MODIFIED_PRESETS, neutral.modified),
    size: pick(first(raw.size), SIZE_PRESETS.filter((size) => size !== 'custom'), neutral.size),
    personId: first(raw.owner) || null,
    mime: (first(raw.mime) ?? '').trim().toLowerCase(),
    tags: [...new Set(all(raw.tags).map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
    around: fromWindowQuery(raw),
  };
}

/** Canonical form of a filter as an address, for telling "the URL already says this" from "it does not". */
export function filterQueryKey(filter: ListingFilter): string {
  return JSON.stringify(toFilterQuery(filter));
}

function pick<T extends string, F>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function first(value: LocationQuery[string]): string | null {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single : null;
}

function all(value: LocationQuery[string]): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');
}
