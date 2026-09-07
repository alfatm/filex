import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
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

  /** `target` overrides the open folder: a drop on a folder card uploads into that folder. */
  function start(list: FileList | File[], target?: string) {
    const parentId = target ?? files.targetFolderId;
    if (!parentId) return;
    for (const file of Array.from(list)) {
      const item: UploadItem = { id: ++seq, name: file.name, size: file.size, progress: 0, done: false };
      items.value.push(item);
      const timer = setInterval(() => {
        const current = items.value.find((i) => i.id === item.id);
        if (!current) return clearInterval(timer);
        current.progress = Math.min(100, current.progress + (100 * TICK_MS) / UPLOAD_MS);
        if (current.progress < 100) return;
        clearInterval(timer);
        current.done = true;
        void files.addUploaded(parentId, { name: file.name, size: file.size });
      }, TICK_MS);
    }
  }

  /** Closing the tray drops the finished rows only: an in-flight upload keeps running and stays visible. */
  function clear() {
    items.value = items.value.filter((i) => !i.done);
  }

  return { items, open, doneCount, start, clear };
});
