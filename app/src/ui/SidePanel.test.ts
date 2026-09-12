import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
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
