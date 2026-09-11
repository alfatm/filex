import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFilesStore } from '@/stores/files';
import { filterQueryKey, fromFilterQuery, toFilterQuery } from './filterQuery';

/**
 * Keeps the chips and the address in step, on the pages that have a listing to narrow.
 *
 * The URL is the source of truth: it is read before the page opens its listing, so the first request is already
 * the filtered one, and every later change to the chips is written back with `replace` — a filter is an adjustment
 * to the view, not a place, and one that pushed a history entry per chip would make Back a slow undo of one's own
 * clicks. Back still takes the whole filter off, because arriving at the folder pushed an entry of its own.
 *
 * Moving to another folder therefore drops the filter, which is what an address-shaped filter means: a listing is
 * `/files/main/Docs`, and the narrowing is part of that address rather than a mode the person carries around.
 */
export function useFilterQuery() {
  const route = useRoute();
  const router = useRouter();
  const files = useFilesStore();

  /** Which listing we are on, so a query change can be told from an arrival somewhere new. */
  const placeKey = () => `${String(route.name)}:${JSON.stringify(route.params)}`;
  let place = placeKey();

  // Before the page's own watcher opens anything: the listing is then asked for filtered, once.
  files.filter = fromFilterQuery(route.query);

  watch(
    () => route.query,
    (raw) => {
      const next = fromFilterQuery(raw);
      const here = placeKey();
      const moved = here !== place;
      place = here;
      if (filterQueryKey(next) === filterQueryKey(files.filter)) return;
      // Somewhere new: the page reloads on its own for the navigation, so the filter is only put in place.
      if (moved) files.filter = next;
      else void files.setFilter(next);
    },
  );

  watch(
    () => files.filter,
    (filter) => {
      // Equal already means this change CAME from the address; writing it back would be a loop.
      if (filterQueryKey(filter) === filterQueryKey(fromFilterQuery(route.query))) return;
      void router.replace({ query: toFilterQuery(filter) });
    },
    { deep: true },
  );
}
