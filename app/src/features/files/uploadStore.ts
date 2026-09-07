import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import { useFilesStore } from '@/stores/files';

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  /** 0..100, from the byte count the server has accepted — not from a clock. */
  progress: number;
  done: boolean;
  /** Set when the transfer failed; the row stays in the tray saying so instead of hanging at its last percent. */
  failed?: boolean;
}

export const useUploadStore = defineStore('uploads', () => {
  const files = useFilesStore();
  const items = ref<UploadItem[]>([]);
  const open = computed(() => items.value.length > 0);
  const doneCount = computed(() => items.value.filter((i) => i.done).length);
  const failedCount = computed(() => items.value.filter((i) => i.failed).length);
  let seq = 0;

  /**
   * `target` overrides the open folder: a drop on a folder card uploads into that folder. A folder upload arrives
   * as a flat list whose files carry `webkitRelativePath`, so the missing folders of each path are created first.
   */
  async function start(list: FileList | File[], target?: string) {
    const root = target ?? files.targetFolderId;
    if (!root) return;
    const chain = new Map<string, string>([['', root]]);
    let createdFolder = false;
    for (const file of Array.from(list)) {
      const parts = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1) : [];
      const parentId = await folderFor(root, parts, chain);
      createdFolder ||= parts.length > 0;
      void transfer(file, parentId);
    }
    // The tree is there long before the first file finishes; show it right away.
    if (createdFolder) await files.refresh();
  }

  /** Walks `parts` under `root`, reusing folders that exist and creating the rest; `chain` caches both. */
  async function folderFor(root: string, parts: string[], chain: Map<string, string>): Promise<string> {
    let parentId = root;
    let path = '';
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      const known = chain.get(path);
      if (known !== undefined) {
        parentId = known;
        continue;
      }
      const siblings = await repository.listFolder(parentId);
      const existing = siblings.find((n) => n.kind === 'folder' && n.name === name);
      const node = existing ?? (await repository.createFolder(parentId, name));
      chain.set(path, node.id);
      parentId = node.id;
    }
    return parentId;
  }

  /**
   * One transfer, one row. The bar follows what the repository reports — bytes the server has accepted — and the
   * row is only ticked done once the upload resolves, which for a real server means the storage has the file, not
   * merely that filex staged it.
   */
  async function transfer(file: File, parentId: string) {
    const item: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, done: false };
    items.value.push(item);
    const live = () => items.value.find((i) => i.id === item.id);
    try {
      await files.addUploaded(parentId, { name: file.name, size: file.size, blob: file }, {
        onProgress: (sent, total) => {
          const row = live();
          if (row) row.progress = total ? Math.min(100, (100 * sent) / total) : 100;
        },
      });
      const row = live();
      if (row) {
        row.progress = 100;
        row.done = true;
      }
    } catch {
      // The store's own error banner is for the listing; a failed transfer belongs to its row in the tray.
      const row = live();
      if (row) row.failed = true;
    }
  }

  /** Closing the tray drops the rows that are over — finished or failed; an in-flight upload keeps running. */
  function clear() {
    items.value = items.value.filter((i) => !i.done && !i.failed);
  }

  return { items, open, doneCount, failedCount, start, clear };
});
