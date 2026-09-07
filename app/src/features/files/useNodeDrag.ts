import type { Node } from '@/data/types';
import { useFilesStore } from '@/stores/files';
import { useDragStore } from './dragStore';
import { useUploadStore } from './uploadStore';

/** Drag handlers shared by the cards, the table rows and the breadcrumbs: drop nodes to move, drop files to upload. */
export function useNodeDrag() {
  const drag = useDragStore();
  const files = useFilesStore();
  const uploads = useUploadStore();

  /** Dragging a selected node takes the whole selection, exactly as its menu actions do. */
  function onDragStart(node: Node, event: DragEvent) {
    if (node.deletedAt) return event.preventDefault();
    const payload = files.isSelected(node.id) && files.selected.length > 1 ? files.selected : [node];
    drag.start(payload);
    event.dataTransfer?.setData('text/plain', payload.map((n) => n.name).join('\n'));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(node: Node, event: DragEvent) {
    if (event.dataTransfer?.types.includes('Files')) drag.files = true;
    if (!drag.canDrop(node)) return;
    // Stopped so the page-wide upload zone does not light up behind the folder under the pointer.
    event.preventDefault();
    event.stopPropagation();
    drag.overId = node.id;
    if (event.dataTransfer) event.dataTransfer.dropEffect = drag.files ? 'copy' : 'move';
  }

  function onDragLeave(node: Node) {
    if (drag.overId === node.id) drag.overId = null;
  }

  async function onDrop(node: Node, event: DragEvent) {
    if (!drag.canDrop(node)) return;
    event.preventDefault();
    event.stopPropagation();
    const dropped = event.dataTransfer?.files;
    const moved = [...drag.nodes];
    drag.end();
    if (dropped?.length) await uploads.start(dropped, node.id);
    else if (moved.length) await files.move(moved, node);
  }

  return { drag, onDragStart, onDragOver, onDragLeave, onDrop };
}
