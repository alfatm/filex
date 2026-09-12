import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Node } from '@/data/types';
import { MENU_WIDTH, useItemMenuStore } from './itemMenuStore';

const node = { id: 'design', name: 'Design', kind: 'folder' } as Node;

function anchor(rect: Partial<DOMRect>): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}, ...rect });
  return button;
}

describe('item menu store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = '';
  });

  it('openAt places the menu at the pointer and remembers the focused element', () => {
    const menu = useItemMenuStore();
    const focused = anchor({});
    focused.focus();
    menu.openAt(node, 120, 340);
    expect(menu.state).toMatchObject({ node, x: 120, y: 340, returnTo: focused });
  });

  it('openFor right-aligns the menu below the ⋮ button and returns focus to it on close', () => {
    const menu = useItemMenuStore();
    const button = anchor({ right: 900, bottom: 200 });
    menu.openFor(node, button);
    expect(menu.state).toMatchObject({ x: 900 - MENU_WIDTH, y: 206, returnTo: button });
    menu.close();
    expect(menu.state).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('never places the menu off the left edge', () => {
    const menu = useItemMenuStore();
    menu.openFor(node, anchor({ right: 40, bottom: 10 }));
    expect(menu.state?.x).toBe(0);
  });
});
