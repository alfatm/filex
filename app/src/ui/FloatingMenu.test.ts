import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import FloatingMenu from './FloatingMenu.vue';

const items = [
  { id: 'open', label: 'Open' },
  { id: 'preview', label: 'Preview', disabled: true, hint: 'Coming soon' },
  { id: 'trash', label: 'Move to trash', danger: true, dividerBefore: true },
];

function key(key: string) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

async function setup() {
  document.body.innerHTML = '';
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();
  const wrapper = mount(FloatingMenu, { attachTo: document.body, props: { items, x: 10, y: 20, label: 'More' } });
  await nextTick();
  await nextTick();
  return { wrapper, trigger, buttons: () => wrapper.findAll('button') };
}

describe('FloatingMenu', () => {
  let wrapper: ReturnType<typeof mount> | undefined;
  afterEach(() => wrapper?.unmount());

  it('focuses the first enabled item; arrows cycle through every item, disabled ones included', async () => {
    const s = await setup();
    wrapper = s.wrapper;
    const [open, preview, trash] = s.buttons().map((b) => b.element);
    expect(document.activeElement).toBe(open);
    key('ArrowDown');
    expect(document.activeElement).toBe(preview);
    expect(preview.getAttribute('aria-disabled')).toBe('true');
    expect(preview.getAttribute('title')).toBe('Coming soon');
    key('ArrowDown');
    expect(document.activeElement).toBe(trash);
    key('ArrowDown');
    expect(document.activeElement).toBe(open);
    key('ArrowUp');
    expect(document.activeElement).toBe(trash);
  });

  it('emits select for enabled items only', async () => {
    const s = await setup();
    wrapper = s.wrapper;
    await s.buttons()[1].trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    await s.buttons()[2].trigger('click');
    expect(wrapper.emitted('select')).toEqual([['trash']]);
  });

  it('Escape closes and is consumed; Tab closes without being consumed; focus returns to the trigger on unmount', async () => {
    const s = await setup();
    wrapper = s.wrapper;
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(wrapper.emitted('close')).toHaveLength(2);

    wrapper.unmount();
    wrapper = undefined;
    expect(document.activeElement).toBe(s.trigger);
  });

  it('closes on a pointer press outside, not inside', async () => {
    const s = await setup();
    wrapper = s.wrapper;
    s.buttons()[0].element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
