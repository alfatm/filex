import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { atWidth, DESKTOP, PHONE } from '@/test/viewport';
import SidePanel from './SidePanel.vue';

const handle = (wrapper: ReturnType<typeof mount>) => wrapper.find('[role="separator"]');

afterEach(() => {
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

describe('SidePanel', () => {
  it('renders no handle without a resize label', () => {
    expect(handle(mount(SidePanel, { props: { width: 400 } })).exists()).toBe(false);
  });

  it('reports the width as the pointer drags the left edge, until release', async () => {
    const wrapper = mount(SidePanel, { props: { width: 432, resizeLabel: 'Resize' } });
    await handle(wrapper).trigger('pointerdown', { button: 0, clientX: 1000 });
    expect(document.body.style.cursor).toBe('col-resize');
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 900 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 1050 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 1050 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 }));
    expect(wrapper.emitted('resize')).toEqual([[532], [382]]);
    expect(document.body.style.cursor).toBe('');
  });

  it('ignores secondary buttons', async () => {
    const wrapper = mount(SidePanel, { props: { width: 432, resizeLabel: 'Resize' } });
    await handle(wrapper).trigger('pointerdown', { button: 2, clientX: 1000 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 900 }));
    expect(wrapper.emitted('resize')).toBeUndefined();
  });

  it('steps the width from the keyboard: left widens, right narrows', async () => {
    const wrapper = mount(SidePanel, { props: { width: 432, resizeLabel: 'Resize' } });
    await handle(wrapper).trigger('keydown', { key: 'ArrowLeft' });
    await handle(wrapper).trigger('keydown', { key: 'ArrowRight' });
    await handle(wrapper).trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.emitted('resize')).toEqual([[448], [416]]);
  });
});

describe('SidePanel below the desktop breakpoint', () => {
  // Spec §10: in the flow beside the listing on a desktop, over it on a phone — 390px has no column to spare.
  it('draws a modal instead of taking a column', async () => {
    atWidth(PHONE);
    const Panel = (await import('./SidePanel.vue')).default;
    // A focusable child, because that is what the panel always has and what the focus trap is there for.
    const wrapper = mount(Panel, {
      props: { width: 256 },
      slots: { default: '<button type="button">Close</button>' },
      attachTo: document.body,
    });
    await flushPromises();

    expect(wrapper.find('aside').exists()).toBe(false);
    // headlessui portals the dialog out of the component, so it is the document that is asked, not the wrapper.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    wrapper.unmount();
  });

  it('keeps the column, and the drag handle, at the design width', async () => {
    atWidth(DESKTOP);
    const Panel = (await import('./SidePanel.vue')).default;
    const wrapper = mount(Panel, { props: { width: 256, resizeLabel: 'Resize' }, attachTo: document.body });

    expect(wrapper.find('aside').attributes('style')).toContain('256px');
    expect(wrapper.find('[role="separator"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('SidePanel on a phone', () => {
  const shape = async (mobile: 'sheet' | 'full') => {
    atWidth(PHONE);
    const Panel = (await import('./SidePanel.vue')).default;
    const wrapper = mount(Panel, {
      props: { width: 256, mobile },
      slots: { default: '<button type="button">Close</button>' },
      attachTo: document.body,
    });
    await flushPromises();
    // The PANEL, not the backdrop beside it — both are `fixed`, and the backdrop comes first in the document.
    const classes = document.querySelector('[id^="headlessui-dialog-panel"]')?.className ?? '';
    wrapper.unmount();
    return classes;
  };

  // An inspector comes up from the bottom; a conversation takes the screen (spec §10).
  it('draws the details inspector as a bottom sheet', async () => {
    expect(await shape('sheet')).toContain('bottom-0');
  });

  it('gives the assistant the whole screen', async () => {
    expect(await shape('full')).toContain('inset-0');
  });
});
