import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { repository } from '@/data';
import { useFilesStore } from '@/stores/files';

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  /** 0..100 */
  progress: number;
  done: boolean;
}

/** Fake transfer: every file completes in ~1.5 s, then it is added to the target folder in the repository. */
export const UPLOAD_MS = 1500;
const TICK_MS = 100;

export const useUploadStore = defineStore('uploads', () => {
  const files = useFilesStore();
  const items = ref<UploadItem[]>([]);
  const open = computed(() => items.value.length > 0);
  const doneCount = computed(() => items.value.filter((i) => i.done).length);
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
      transfer(file, parentId);
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

  /** The fake transfer: a row that fills up, then the node itself. */
  function transfer(file: File, parentId: string) {
    const item: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, done: false };
    items.value.push(item);
    const timer = setInterval(() => {
      const current = items.value.find((i) => i.id === item.id);
      if (!current) return clearInterval(timer);
      current.progress = Math.min(100, current.progress + (100 * TICK_MS) / UPLOAD_MS);
      if (current.progress < 100) return;
      clearInterval(timer);
      current.done = true;
      void files.addUploaded(parentId, { name: file.name, size: file.size, blob: file });
    }, TICK_MS);
  }

  /** Closing the tray drops the finished rows only: an in-flight upload keeps running and stays visible. */
  function clear() {
    items.value = items.value.filter((i) => !i.done);
  }

  return { items, open, doneCount, start, clear };
});
