import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FilePlus, FolderPlus, FolderUp, Upload } from 'lucide-vue-next';
import type { RolePermission } from '@/data/types';
import { useCapabilitiesStore } from '@/stores/capabilities';
import type { FloatingMenuEntry } from '@/ui/FloatingMenu.vue';
import { useModalsStore } from './modalsStore';
import { useUploadStore } from './uploadStore';

/**
 * The "New" menu — new folder, new file, upload files, upload folder.
 *
 * It lives in a composable because it now has two triggers: the sidebar's button on a desktop, and the `+` in the
 * listing toolbar on a phone, where the sidebar is a drawer and carrying the same menu in both would be two ways
 * into one thing on a 390px screen (spec §10). The caller renders the trigger, the menu and the two hidden file
 * inputs; everything that decides what the menu SAYS is here.
 */
const MENU_GAP = 6;

export function useNewMenu() {
  const { t } = useI18n();
  const capabilities = useCapabilitiesStore();
  const modals = useModalsStore();
  const uploads = useUploadStore();

  const menu = ref<{ x: number; y: number } | null>(null);
  const fileInput = ref<HTMLInputElement>();
  const folderInput = ref<HTMLInputElement>();

  /** An action the server cannot do, or this account may not, stays in the menu and says which of the two it is. */
  function gate(supported: boolean, permission: RolePermission) {
    if (!supported) return { disabled: true, hint: t('common.unavailable') };
    if (!capabilities.allows(permission)) return { disabled: true, hint: t('common.notAllowed') };
    return {};
  }

  const items = computed<FloatingMenuEntry[]>(() => [
    { id: 'folder', label: t('new.folder'), icon: FolderPlus, ...gate(capabilities.can.mkdir, 'files.mkdir') },
    { id: 'file', label: t('new.file'), icon: FilePlus, ...gate(capabilities.can.upload, 'files.upload') },
    { id: 'fileUpload', label: t('new.fileUpload'), icon: Upload, dividerBefore: true, ...gate(capabilities.can.upload, 'files.upload') },
    { id: 'folderUpload', label: t('new.folderUpload'), icon: FolderUp, ...gate(capabilities.can.upload, 'files.upload') },
  ]);

  function openAt(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    menu.value = { x: rect.left, y: rect.bottom + MENU_GAP };
  }

  function select(id: string) {
    menu.value = null;
    if (id === 'folder') modals.open({ kind: 'newFolder' });
    else if (id === 'file') modals.open({ kind: 'newFile' });
    else if (id === 'fileUpload') fileInput.value?.click();
    else if (id === 'folderUpload') folderInput.value?.click();
  }

  /** The native pickers hand back a flat list; `webkitRelativePath` is what the upload store rebuilds folders from. */
  function onFilesPicked(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) void uploads.start(input.files);
    input.value = '';
  }

  return { menu, items, fileInput, folderInput, openAt, select, onFilesPicked };
}
