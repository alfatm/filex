import type { Composer } from 'vue-i18n';
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderInput,
  History,
  PencilLine,
  RotateCcw,
  Share2,
  Star,
  StarOff,
  Tag,
  Trash2,
  UserCog,
} from 'lucide-vue-next';
import type { Node } from '@/data/types';
import type { FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

/**
 * Item ⋮ / context menu (spec §7). Entries without a handler yet are disabled with a "coming soon" hint; Preview and
 * Download exist for files only (a folder download needs a zip endpoint). Trashed nodes get Restore / Delete forever only.
 */
export function itemMenuEntries(t: Composer['t'], node: Node): FloatingMenuEntry[] {
  if (node.deletedAt) {
    return [
      { id: 'restore', label: t('menu.restore'), icon: RotateCcw },
      { id: 'deleteForever', label: t('menu.deleteForever'), icon: Trash2, danger: true, dividerBefore: true },
    ];
  }
  const soon = t('common.comingSoon');
  const folder = node.kind === 'folder';
  return [
    { id: 'open', label: t('menu.open'), icon: ExternalLink },
    { id: 'preview', label: t('menu.preview'), icon: Eye, disabled: folder, hint: soon },
    { id: 'download', label: t('menu.download'), icon: Download, disabled: folder, hint: soon },
    { id: 'share', label: t('menu.share'), icon: Share2 },
    { id: 'rename', label: t('menu.rename'), icon: PencilLine },
    { id: 'moveTo', label: t('menu.moveTo'), icon: FolderInput },
    { id: 'copyTo', label: t('menu.copyTo'), icon: Copy, disabled: true, hint: soon },
    node.starred
      ? { id: 'removeFromStarred', label: t('menu.removeFromStarred'), icon: StarOff }
      : { id: 'addToStarred', label: t('menu.addToStarred'), icon: Star },
    { id: 'tags', label: t('menu.tags'), icon: Tag, disabled: true, hint: soon },
    { id: 'versionHistory', label: t('menu.versionHistory'), icon: History, disabled: true, hint: soon },
    { id: 'manageAccess', label: t('menu.manageAccess'), icon: UserCog, disabled: true, hint: soon },
    { id: 'moveToTrash', label: t('menu.moveToTrash'), icon: Trash2, danger: true, dividerBefore: true },
  ];
}
