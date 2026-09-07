import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { filesRoute } from '@/lib/path';
import { useFilesStore } from '@/stores/files';
import { useToastStore } from '@/stores/toast';
import { useModalsStore } from './modalsStore';
import { downloadUrl, previewList } from './preview';

/** Maps item-menu ids (see `itemMenuEntries`) to store calls and modals; shared by menus, cards and the selection bar. */
export function useFileActions() {
  const { t } = useI18n();
  const router = useRouter();
  const files = useFilesStore();
  const modals = useModalsStore();
  const toast = useToastStore();

  /** Folders navigate through the router so the URL owns the state; files open the preview modal. */
  async function open(node: Node, siblings?: Node[]) {
    if (node.deletedAt) return;
    if (node.kind === 'file') return preview(node, siblings);
    const chain = await repository.getPath(node.id);
    await router.push(filesRoute([...chain.slice(1), node].map((n) => n.name)));
  }

  /**
   * Opens the preview on `node`; ← → walk the files of `siblings` (default: the current listing) in their order.
   * The listing is empty on Search / Home, so those pass their own rows or get a single-file preview.
   */
  function preview(node: Node, siblings: Node[] = files.files) {
    modals.open({ kind: 'preview', ...previewList(siblings, node) });
  }

  /** Single files only: a real anchor click so the browser saves the file (folders / selections need a zip endpoint). */
  function download(node: Node) {
    const url = downloadUrl(node);
    if (!url) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = node.name;
    anchor.click();
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
        return download(node);
      case 'share':
        return modals.open({ kind: 'share', node });
      case 'rename':
        return modals.open({ kind: 'rename', node });
      case 'moveTo':
        return modals.open({ kind: 'move', nodes });
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

  return { open, preview, run, copyLink };
}
