import { DOMWrapper, mount } from '@vue/test-utils';
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
  // Teleported to the body, so the menu is outside the wrapper's own element.
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].map((el) => new DOMWrapper(el));
  return { wrapper, trigger, buttons };
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

  // Pressing a row's ⋮ focuses it, and below roughly 1500px the browser scrolls the listing's horizontally
  // scrollable wrapper to reveal it. That event arrives milliseconds after the menu opened, and any scroll used to
  // close the menu — so on a narrow window the row menu opened and vanished on its own.
  it('survives a scroll that left its anchor where it was, and goes when the anchor moves', async () => {
    document.body.innerHTML = '';
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    let left = 100;
    trigger.getBoundingClientRect = () => new DOMRect(left, 40, 20, 20);
    wrapper = mount(FloatingMenu, { attachTo: document.body, props: { items, x: 10, y: 20, label: 'More', anchor: trigger } });
    await nextTick();
    await nextTick();

    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(wrapper.emitted('close')).toBeUndefined();

    left = 40;
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('closes on any scroll when it was opened at a bare point, with nothing to follow', async () => {
    const s = await setup();
    wrapper = s.wrapper;
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  // Below `xl` the filter chips sit in a side-scroller with a `mask-image`, which is a containing block for fixed
  // descendants: the chip menus were clipped to the chips' own strip and painted nothing, while still being in the
  // DOM and "visible" to a test. Where the menu is MOUNTED is therefore part of the contract.
  it('renders at the body, not inside the element that opened it', async () => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    document.body.appendChild(host);
    wrapper = mount(FloatingMenu, { attachTo: host, props: { items, x: 10, y: 20, label: 'More' } });
    await nextTick();
    expect(document.querySelector('[role="menu"]')?.parentElement).toBe(document.body);
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
