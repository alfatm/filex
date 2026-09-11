import type { Composer } from 'vue-i18n';
import {
  CheckSquare,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Eye,
  ClipboardPaste,
  FilePlus,
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
import type { Capabilities, Node, RolePermission } from '@/data/types';
import type { FloatingMenuEntry } from '@/ui/FloatingMenu.vue';

/**
 * Item ⋮ / context menu (spec §7). Entries without a handler yet are disabled with a "coming soon" hint; Preview and
 * Download exist for files only (a folder download needs a zip endpoint). Trashed nodes get Restore / Delete forever only.
 */
export function itemMenuEntries(t: Composer['t'], node: Node, can: Capabilities): FloatingMenuEntry[] {
  // An entry the server cannot serve keeps its place and says so, rather than vanishing from a familiar menu.
  const off = t('common.unavailable');
  const gate = gateOf(t, can);
  if (node.deletedAt) {
    return [
      { id: 'restore', label: t('menu.restore'), icon: RotateCcw, ...gate(true, 'files.restore') },
      { id: 'deleteForever', label: t('menu.deleteForever'), icon: Trash2, danger: true, dividerBefore: true, ...gate(can.deleteForever, 'files.purge') },
    ];
  }
  const folder = node.kind === 'folder';
  return [
    { id: 'open', label: t('menu.open'), icon: ExternalLink },
    { id: 'preview', label: t('menu.preview'), icon: Eye, disabled: folder, hint: off },
    // A folder download is one archive, which needs an endpoint of its own.
    { id: 'download', label: t('menu.download'), icon: Download, ...gate(folder ? can.folderDownload : true, 'files.download') },
    { id: 'share', label: t('menu.share'), icon: Share2, ...gate(true, 'files.share') },
    { id: 'rename', label: t('menu.rename'), icon: PencilLine, ...gate(true, 'files.rename') },
    { id: 'moveTo', label: t('menu.moveTo'), icon: FolderInput, ...gate(can.move, 'files.move') },
    { id: 'cut', label: t('menu.cut'), icon: Scissors, ...gate(can.move, 'files.move') },
    { id: 'copy', label: t('menu.copy'), icon: Copy, ...gate(can.copy, 'files.copy') },
    { id: 'copyTo', label: t('menu.copyTo'), icon: CopyPlus, ...gate(can.copy, 'files.copy') },
    node.starred
      ? { id: 'removeFromStarred', label: t('menu.removeFromStarred'), icon: StarOff, ...gate(true, 'files.star') }
      : { id: 'addToStarred', label: t('menu.addToStarred'), icon: Star, ...gate(true, 'files.star') },
    { id: 'tags', label: t('menu.tags'), icon: Tag, ...gate(can.tags, 'files.tags') },
    // Listing the revisions is the harmless half; the button on every row of it restores one, which is the verb
    // the permission is about, so the entry is gated on it rather than opening a modal that can only refuse.
    { id: 'versionHistory', label: t('menu.versionHistory'), icon: History, ...gate(can.versions, 'files.restore') },
    { id: 'manageAccess', label: t('menu.manageAccess'), icon: UserCog, ...gate(can.permissions, 'files.grant') },
    { id: 'moveToTrash', label: t('menu.moveToTrash'), icon: Trash2, danger: true, dividerBefore: true, ...gate(can.delete, 'files.delete') },
  ];
}

/**
 * Two questions, two sentences.
 *
 * `supported` is the INSTALLATION's answer — the storage driver, or an endpoint that exists — and a no there is
 * "Not available on this server". `permission` is the caller's ROLE, and a no there is "Your role may not do this":
 * the same action, refused by a rule an administrator set, which is a different thing to tell somebody. Both have
 * to say yes; the installation is asked first, because a feature the server does not have is not a role problem.
 */
function gateOf(t: Composer['t'], can: Capabilities) {
  const off = t('common.unavailable');
  const notAllowed = t('common.notAllowed');
  return (supported: boolean, permission?: RolePermission) => {
    if (!supported) return { disabled: true, hint: off };
    if (permission && !can.allowed.has(permission)) return { disabled: true, hint: notAllowed };
    return {};
  };
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
  const gate = gateOf(t, can);
  return [
    ...(state.canCreate
      ? [
          { id: 'newFolder', label: t('new.folder'), icon: FolderPlus, ...gate(can.mkdir, 'files.mkdir') },
          // An empty file is a write like an upload is, so it is gated on the same capability.
          { id: 'newFile', label: t('new.file'), icon: FilePlus, ...gate(can.upload, 'files.upload') },
          { id: 'fileUpload', label: t('new.fileUpload'), icon: Upload, ...gate(can.upload, 'files.upload') },
          // `canPaste` already knows which verb the pending clipboard needs; gating on `move` here refused a paste
          // after a COPY on a server that offers copy but not move.
          { id: 'paste', label: t('menu.paste'), icon: ClipboardPaste, disabled: !state.canPaste },
        ]
      : []),
    { id: 'selectAll', label: t('menu.selectAll'), icon: CheckSquare, dividerBefore: state.canCreate, disabled: !state.canSelectAll },
    { id: 'clearSelection', label: t('menu.clearSelection'), icon: Square, disabled: !state.hasSelection },
  ];
}
