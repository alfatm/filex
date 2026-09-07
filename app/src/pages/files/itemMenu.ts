import type { Composer } from 'vue-i18n';
import {
  CheckSquare,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Eye,
  ClipboardPaste,
  FolderInput,
  FolderPlus,
  History,
  PencilLine,
  RotateCcw,
  Scissors,
  Share2,
  Square,
  Star,
  StarOff,
  Tag,
  Trash2,
  Upload,
  UserCog,
} from 'lucide-vue-next';
import type { Capabilities, Node } from '@/data/types';
import type { FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

/**
 * Item ⋮ / context menu (spec §7). Entries without a handler yet are disabled with a "coming soon" hint; Preview and
 * Download exist for files only (a folder download needs a zip endpoint). Trashed nodes get Restore / Delete forever only.
 */
export function itemMenuEntries(t: Composer['t'], node: Node, can: Capabilities): FloatingMenuEntry[] {
  // An entry the server cannot serve keeps its place and says so, rather than vanishing from a familiar menu.
  const off = t('common.unavailable');
  const gate = (allowed: boolean) => (allowed ? {} : { disabled: true, hint: off });
  if (node.deletedAt) {
    return [
      { id: 'restore', label: t('menu.restore'), icon: RotateCcw },
      { id: 'deleteForever', label: t('menu.deleteForever'), icon: Trash2, danger: true, dividerBefore: true, ...gate(can.deleteForever) },
    ];
  }
  const folder = node.kind === 'folder';
  return [
    { id: 'open', label: t('menu.open'), icon: ExternalLink },
    { id: 'preview', label: t('menu.preview'), icon: Eye, disabled: folder, hint: off },
    // A folder download is one archive, which needs an endpoint of its own.
    { id: 'download', label: t('menu.download'), icon: Download, ...(folder ? gate(can.folderDownload) : {}) },
    { id: 'share', label: t('menu.share'), icon: Share2 },
    { id: 'rename', label: t('menu.rename'), icon: PencilLine },
    { id: 'moveTo', label: t('menu.moveTo'), icon: FolderInput, ...gate(can.move) },
    { id: 'cut', label: t('menu.cut'), icon: Scissors, ...gate(can.move) },
    { id: 'copy', label: t('menu.copy'), icon: Copy, ...gate(can.copy) },
    { id: 'copyTo', label: t('menu.copyTo'), icon: CopyPlus, ...gate(can.copy) },
    node.starred
      ? { id: 'removeFromStarred', label: t('menu.removeFromStarred'), icon: StarOff }
      : { id: 'addToStarred', label: t('menu.addToStarred'), icon: Star },
    { id: 'tags', label: t('menu.tags'), icon: Tag, ...gate(can.tags) },
    { id: 'versionHistory', label: t('menu.versionHistory'), icon: History, ...gate(can.versions) },
    { id: 'manageAccess', label: t('menu.manageAccess'), icon: UserCog, ...gate(can.permissions) },
    { id: 'moveToTrash', label: t('menu.moveToTrash'), icon: Trash2, danger: true, dividerBefore: true, ...gate(can.delete) },
  ];
}

/**
 * Right-click on empty listing surface, and the grid's ⋮ button: what can be done to the listing rather than to a
 * node. The flat listings (Recent, Starred, Trash) hold no folder to create in, so they keep the selection entries.
 */
export function listingMenuEntries(
  t: Composer['t'],
  can: Capabilities,
  state: { canCreate: boolean; canPaste: boolean; canSelectAll: boolean; hasSelection: boolean },
): FloatingMenuEntry[] {
  const off = t('common.unavailable');
  return [
    ...(state.canCreate
      ? [
          { id: 'newFolder', label: t('new.folder'), icon: FolderPlus, ...(can.mkdir ? {} : { disabled: true, hint: off }) },
          { id: 'fileUpload', label: t('new.fileUpload'), icon: Upload, ...(can.upload ? {} : { disabled: true, hint: off }) },
          { id: 'paste', label: t('menu.paste'), icon: ClipboardPaste, disabled: !state.canPaste || !can.move },
        ]
      : []),
    { id: 'selectAll', label: t('menu.selectAll'), icon: CheckSquare, dividerBefore: state.canCreate, disabled: !state.canSelectAll },
    { id: 'clearSelection', label: t('menu.clearSelection'), icon: Square, disabled: !state.hasSelection },
  ];
}
