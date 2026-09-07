import type { Composer } from 'vue-i18n';
import {
  CheckSquare,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderInput,
  FolderPlus,
  History,
  PencilLine,
  RotateCcw,
  Share2,
  Square,
  Star,
  StarOff,
  Tag,
  Trash2,
  Upload,
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

/**
 * Right-click on empty listing surface, and the grid's ⋮ button: what can be done to the listing rather than to a
 * node. The flat listings (Recent, Starred, Trash) hold no folder to create in, so they keep the selection entries.
 */
export function listingMenuEntries(t: Composer['t'], state: { canCreate: boolean; canSelectAll: boolean; hasSelection: boolean }): FloatingMenuEntry[] {
  return [
    ...(state.canCreate
      ? [
          { id: 'newFolder', label: t('new.folder'), icon: FolderPlus },
          { id: 'fileUpload', label: t('new.fileUpload'), icon: Upload },
        ]
      : []),
    { id: 'selectAll', label: t('menu.selectAll'), icon: CheckSquare, dividerBefore: state.canCreate, disabled: !state.canSelectAll },
    { id: 'clearSelection', label: t('menu.clearSelection'), icon: Square, disabled: !state.hasSelection },
  ];
}
