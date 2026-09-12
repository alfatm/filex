import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import type { Node } from '@/data/types';
import { i18n } from '@/i18n';
import PreviewModal from './PreviewModal.vue';

// `.txt` with no asset URL: `previewKind` answers "none", so the modal draws its download card and fetches nothing.
const file: Node = {
  id: 'demo://notes.txt',
  name: 'notes.txt',
  kind: 'file',
  parentId: 'demo://',
  size: 12,
  ownerId: 'u1',
  fileType: 'other',
  modifiedAt: '2026-09-09T12:00:00Z',
  shared: false,
  starred: false,
};

const second: Node = { ...file, id: 'demo://next.txt', name: 'next.txt' };

// headlessui renders the dialog in a portal at the body, so the panel is not inside the wrapper's own element.
async function open(nodes: Node[] = [file]) {
  const wrapper = mount(PreviewModal, { attachTo: document.body, props: { nodes, index: 0 }, global: { plugins: [i18n] } });
  await nextTick();
  // The stage is the box below the header — what the gesture is measured on, and all a file ever draws in.
  const header = document.querySelector('header');
  if (!header?.nextElementSibling) throw new Error('the preview drew no stage');
  return { wrapper, stage: header.nextElementSibling as HTMLElement };
}

function drag(stage: HTMLElement, pointerType: string, dx: number, dy: number) {
  stage.dispatchEvent(new PointerEvent('pointerdown', { pointerType, clientX: 200, clientY: 200, bubbles: true }));
  stage.dispatchEvent(new PointerEvent('pointermove', { pointerType, clientX: 200 + dx, clientY: 200 + dy, bubbles: true }));
}

const shown = () => document.querySelector('header p')?.textContent;

describe('the preview on a touch screen', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // Opening a file is recorded server-side; the gesture under test has nothing to do with it.
    vi.spyOn(repository, 'recordOpen').mockResolvedValue(undefined);
  });

  // The close button is a 44px target in the corner of a full-screen viewer; the swipe is how a phone dismisses.
  it('closes on a swipe down', async () => {
    const { wrapper, stage } = await open();
    drag(stage, 'touch', 0, 100);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('ignores a short drag, and a mouse drag of any length', async () => {
    const { wrapper, stage } = await open();
    drag(stage, 'touch', 0, 40);
    drag(stage, 'mouse', 0, 300);
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();
  });

  // The chevrons and the arrow keys are the mouse and keyboard version of this; a phone has neither.
  it('walks the listing sideways, and stops at its ends', async () => {
    const { wrapper, stage } = await open([file, second]);
    expect(shown()).toBe(file.name);

    drag(stage, 'touch', -100, 0);
    await nextTick();
    expect(shown()).toBe(second.name);

    // Past the last file there is nothing to turn to, and the swipe must not close the preview instead.
    drag(stage, 'touch', -100, 0);
    await nextTick();
    expect(shown()).toBe(second.name);
    expect(wrapper.emitted('close')).toBeUndefined();

    drag(stage, 'touch', 100, 0);
    await nextTick();
    expect(shown()).toBe(file.name);
    wrapper.unmount();
  });

  // A drag is one gesture: down-and-left is whichever it is MORE of, not a step and a dismissal at once.
  it('gives a diagonal drag to its dominant axis', async () => {
    const { wrapper, stage } = await open([file, second]);
    drag(stage, 'touch', -100, 70);
    await nextTick();
    expect(shown()).toBe(second.name);
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();
  });
});
