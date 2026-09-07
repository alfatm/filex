import { nextTick, ref, watch } from 'vue';
import type { LocationQuery } from 'vue-router';
import { repository } from '@/data';
import { useAssistantStore } from '@/features/assistant/assistantStore';
import { useItemMenuStore } from '@/features/files/itemMenuStore';
import { useModalsStore } from '@/features/files/modalsStore';
import { THEMES, useSettingsStore, type Theme } from '@/features/settings/settingsStore';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { previewList } from '@/features/files/preview';
import { emptyQuery, useSearchStore } from '@/features/search/searchStore';
import { FILE_TYPE_GROUPS, MODIFIED_PRESETS, SIZE_PRESETS, type Capabilities, type ListingFilter } from '@/data/types';
import { joinPath, segments } from '@/lib/path';
import router from '@/router';
import { useFilesStore } from '@/stores/files';
import { useViewStore } from '@/stores/view';

/**
 * Screenshot / e2e hooks — dev builds only (App.vue imports this module behind `import.meta.env.DEV`, so nothing
 * here reaches the production bundle). URL query params put the app into the reference states of
 * app/docs/DESIGN-SPEC.md without a click sequence:
 *
 *   ?view=list|grid            view mode
 *   ?select=<name>             selects the node with that name once the folder is listed (files route)
 *   ?panel=details|assistant|none   the only open right panel (both are independent; details is open by default)
 *   ?modal=search              opens Advanced search with the reference form (tags, path) and "24 matching items"
 *   ?modal=settings            opens the user settings modal
 *   ?theme=light|dark|system   applies a theme without going through the settings modal
 *   ?filter=type:images        sets one listing filter chip (`type`, `modified`, `size`, `person`)
 *   ?caps=assistant:0,tags:1   overrides the capability snapshot, to see a server that lacks a feature
 *   ?modal=rename              opens Rename for the selected node
 *   ?modal=preview             opens the preview of the selected file
 *   ?menu=item                 opens the ⋮ menu of the selected node
 *   ?demo=assistant            seeds the reference conversation once
 *   ?demo=trash                moves two items to the trash before the listing loads
 *
 * Every hook applies once per navigation; a listing refresh after a mutation does not re-apply it.
 */

/** Spec §5 form state: tags "design" / "project alpha", path "/demo/design/", OCR on. */
const REF_SEARCH = { tags: ['design', 'project alpha'], path: '/demo/design/' };
/** The reference screenshot reports 24 matching items; the dataset enumerates only the first few. */
const REF_SEARCH_TOTAL = 24;
const TRASH_DEMO_IDS = ['archive', 'data-csv'];

function first(value: LocationQuery[string]): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single : undefined;
}

/** `?filter=type:images` → the matching field of the listing filter; unknown values are ignored. */
function withChip(filter: ListingFilter, field: string, value: string): ListingFilter {
  const next = { ...filter };
  if (field === 'type' && FILE_TYPE_GROUPS.includes(value as ListingFilter['fileType'])) next.fileType = value as ListingFilter['fileType'];
  else if (field === 'modified' && MODIFIED_PRESETS.includes(value as ListingFilter['modified'])) next.modified = value as ListingFilter['modified'];
  else if (field === 'size' && SIZE_PRESETS.includes(value as ListingFilter['size'])) next.size = value as ListingFilter['size'];
  else if (field === 'person') next.personId = value;
  return next;
}

export function installScreenshotQuery() {
  const route = router.currentRoute;
  const files = useFilesStore();
  const view = useViewStore();
  const modals = useModalsStore();
  const itemMenu = useItemMenuStore();
  const search = useSearchStore();
  const assistant = useAssistantStore();
  const settings = useSettingsStore();
  const capabilities = useCapabilitiesStore();

  let assistantSeeded = false;
  let searchPatched = false;

  /** The live modal reports `REF_SEARCH_TOTAL` whenever anything matches, as in the reference. */
  function patchSearchTotal() {
    if (searchPatched) return;
    searchPatched = true;
    const original = repository.search.bind(repository);
    repository.search = async (query) => {
      const result = await original(query);
      return { ...result, total: result.hits.length ? REF_SEARCH_TOTAL : 0 };
    };
  }

  /** Hooks that need no listing: applied as soon as the URL is seen. */
  async function applyImmediate(query: LocationQuery) {
    const mode = first(query.view);
    if (mode === 'list' || mode === 'grid') view.mode = mode;
    // `?panel=` names the only open panel: refs 2 and 4 show the listing without the details column.
    const panel = first(query.panel);
    if (panel === 'assistant' || panel === 'none' || panel === 'details') {
      view.assistantOpen = panel === 'assistant';
      view.detailsOpen = false;
    }
    const theme = first(query.theme);
    if (THEMES.includes(theme as Theme)) settings.settings.theme = theme as Theme;
    if (first(query.modal) === 'settings') settings.open = true;
    const caps = first(query.caps);
    if (caps) {
      // The snapshot may not have arrived yet; apply the override on top of whatever lands.
      const overrides = caps.split(',').map((pair) => pair.split(':'));
      const apply = () => {
        for (const [name, value] of overrides) {
          if (name in capabilities.can) capabilities.can[name as keyof Capabilities] = value !== '0';
        }
      };
      apply();
      watch(() => capabilities.loaded, apply);
    }
    const chip = first(query.filter)?.split(':');
    if (chip) void files.setFilter(withChip(files.filter, chip[0], chip[1] ?? ''));
    if (first(query.modal) === 'search') {
      patchSearchTotal();
      search.assign({ ...emptyQuery(), ...REF_SEARCH });
      search.openModal(undefined, route.value.name === 'files' ? joinPath(segments(route.value.params.path)) : undefined);
    }
    const demo = first(query.demo);
    if (demo === 'trash') {
      // The mock mutates synchronously; the refresh covers a trash listing that loaded before this module did.
      await repository.moveToTrash(TRASH_DEMO_IDS);
      await files.refresh();
    }
    if (demo === 'assistant' && !assistantSeeded) {
      assistantSeeded = true;
      const { refConversation } = await import('@/data/mock/assistantDemo');
      assistant.seed(refConversation());
    }
  }

  /** Hooks on the listed folder and the selected node: applied once the folder named by the URL is the one listed. */
  async function applyToListing(query: LocationQuery) {
    const select = first(query.select);
    const node = select ? files.ordered.find((n) => n.name === select) : undefined;
    if (node) files.select(node.id);
    // After the selection, so the panel never shows the folder itself first.
    if (first(query.panel) === 'details') view.detailsOpen = true;
    if (!node) return;
    if (first(query.modal) === 'rename') modals.open({ kind: 'rename', node });
    if (first(query.modal) === 'preview' && node.kind === 'file') modals.open({ kind: 'preview', ...previewList(files.files, node) });
    if (first(query.menu) === 'item') {
      await nextTick();
      const button = document.querySelector<HTMLElement>(`#node-${CSS.escape(node.id)} [data-menu-button]`);
      if (button) itemMenu.openFor(node, button);
    }
  }

  /** The listed folder, as route segments; null on the flat listings or before the first load. */
  function listedPath(): string | null {
    if (files.listing?.kind !== 'folder' || !files.folder) return null;
    return joinPath([...files.path, files.folder].slice(1).map((n) => n.name));
  }

  /** Set on every navigation, cleared once the listing hooks ran for it. */
  const pending = ref(false);
  watch(
    () => route.value.fullPath,
    () => {
      pending.value = true;
      void applyImmediate(route.value.query);
    },
    { immediate: true },
  );
  watch(
    () => [pending.value, route.value.name, listedPath()] as const,
    () => {
      if (!pending.value || route.value.name !== 'files' || listedPath() !== joinPath(segments(route.value.params.path))) return;
      pending.value = false;
      void applyToListing(route.value.query);
    },
    { immediate: true, flush: 'post' },
  );
}
