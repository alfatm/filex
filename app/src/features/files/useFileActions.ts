import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { filesRoute } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { useClipboardStore } from './clipboardStore';
import { useModalsStore } from './modalsStore';
import { downloadUrl, previewList } from './preview';

/** Maps item-menu ids (see `itemMenuEntries`) to store calls and modals; shared by menus, cards and the selection bar. */
export function useFileActions() {
  const { t } = useI18n();
  const router = useRouter();
  const files = useFilesStore();
  const modals = useModalsStore();
  const clipboard = useClipboardStore();
  const toast = useToastStore();

  /** Folders navigate through the router so the URL owns the state; files open the preview modal. */
  async function open(node: Node, siblings?: Node[]) {
    if (node.deletedAt) return;
    if (node.kind === 'file') return preview(node, siblings);
    const chain = await repository.getPath(node.id);
    // The chain opens at the drive ROOT, so the drive is a lookup rather than a guess from the id — the two
    // repositories spell an id differently (`main://Docs` over HTTP, `docs` in the mock) and only the root matches.
    const drive = files.storages.find((s) => s.rootId === chain[0]?.id) ?? files.storage;
    if (!drive) return;
    await router.push(filesRoute(drive.id, [...chain.slice(1), node].map((n) => n.name)));
  }

  /**
   * Opens the preview on `node`; ← → walk the files of `siblings` (default: the current listing) in their order.
   * The listing is empty on Search / Home, so those pass their own rows or get a single-file preview.
   */
  function preview(node: Node, siblings: Node[] = files.files) {
    modals.open({ kind: 'preview', ...previewList(siblings, node) });
  }

  /** A real anchor click, so the browser owns the save dialog, the progress and the disk write. */
  function save(url: string, name: string) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  }

  /**
   * One file goes down as itself; anything else — a folder, or several things at once — goes down as one archive,
   * which is also the only way a folder can go down at all. A server that cannot zip (the demo's mock) falls back
   * to a click per file, and a folder in that selection is simply skipped, as it always was.
   */
  function download(nodes: Node[]) {
    const single = nodes.length === 1 && nodes[0].kind === 'file';
    const archive = single ? null : repository.archiveUrl(nodes);
    if (archive) return save(archive, nodes.length === 1 ? `${nodes[0].name}.zip` : 'files.zip');
    for (const node of nodes) {
      const url = node.kind === 'file' ? downloadUrl(node) : null;
      if (url) save(url, node.name);
    }
  }

  /**
   * Runs a menu action on `node`. When `node` is part of a multi-selection, the bulk actions
   * (move, star, trash, restore, delete) apply to the whole selection, as with the selection bar.
   */
  async function run(id: string, node: Node) {
    const nodes = files.isSelected(node.id) && files.selected.length > 1 ? files.selected : [node];
    switch (id) {
      case 'open':
        return open(node);
      case 'preview':
        return preview(node);
      case 'download':
        return download(nodes);
      case 'share':
        return modals.open({ kind: 'share', node });
      case 'rename':
        return modals.open({ kind: 'rename', node });
      case 'moveTo':
        return modals.open({ kind: 'move', nodes });
      case 'cut':
        return clipboard.cut(nodes);
      case 'copy':
        return clipboard.copy(nodes);
      case 'copyTo':
        return modals.open({ kind: 'copy', nodes });
      case 'tags':
        return modals.open({ kind: 'tags', node });
      case 'versionHistory':
        return modals.open({ kind: 'versions', node });
      case 'manageAccess':
        return modals.open({ kind: 'access', node });
      case 'addToStarred':
        return files.setStarred(nodes, true);
      case 'removeFromStarred':
        return files.setStarred(nodes, false);
      case 'moveToTrash':
        return modals.open({ kind: 'delete', variant: 'trash', nodes });
      case 'restore':
        return files.restore(nodes);
      case 'deleteForever':
        return modals.open({ kind: 'delete', variant: 'forever', nodes });
    }
  }

  async function copyLink(url: string) {
    await navigator.clipboard.writeText(url);
    toast.push(t('toast.linkCopied'));
  }

  return { open, preview, download, run, copyLink };
}
