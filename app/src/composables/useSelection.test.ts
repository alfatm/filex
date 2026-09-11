import { ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { useSelection } from './useSelection';

type Item = { id: string };

function setup(list: string[] = ['a', 'b', 'c', 'd', 'e']) {
  // Fresh array per test: some tests re-sort or shrink the list in place.
  const ordered = ref<Item[]>(list.map((id) => ({ id })));
  return { ordered, sel: useSelection(ordered) };
}

function ids(sel: ReturnType<typeof setup>['sel']): string[] {
  return sel.selected.value.map((n) => n.id);
}

function key(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, code: key === 'a' || key === 'A' ? 'KeyA' : '', ctrlKey: false, metaKey: false, ...mods } as KeyboardEvent;
}

function mouse(mods: Partial<MouseEvent> = {}): MouseEvent {
  return { ctrlKey: false, metaKey: false, shiftKey: false, ...mods } as MouseEvent;
}

const noop = { open: () => {} };

describe('useSelection', () => {
  it('plain click replaces the selection and sets focus without a cursor ring', () => {
    const { sel } = setup();
    sel.select('a');
    sel.select('c');
    expect(ids(sel)).toEqual(['c']);
    expect(sel.focusedId.value).toBe('c');
    expect(sel.cursorId.value).toBeNull();
  });

  it('toggle keeps other ids and flips one', () => {
    const { sel } = setup();
    sel.select('a');
    sel.select('c', { toggle: true });
    expect(ids(sel)).toEqual(['a', 'c']);
    sel.toggle('a');
    expect(ids(sel)).toEqual(['c']);
    sel.toggle('a');
    expect(ids(sel)).toEqual(['a', 'c']);
  });

  it('range selects from the anchor in visual order, in both directions', () => {
    const { sel } = setup();
    sel.select('b');
    sel.select('d', { range: true });
    expect(ids(sel)).toEqual(['b', 'c', 'd']);
    sel.select('a', { range: true });
    expect(ids(sel)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('range follows the current order after a re-sort', () => {
    const { ordered, sel } = setup();
    sel.select('b');
    ordered.value = [...ordered.value].reverse(); // e d c b a
    sel.select('d', { range: true });
    expect(ids(sel)).toEqual(['d', 'c', 'b']);
    sel.moveFocus(-1);
    expect(sel.focusedId.value).toBe('e');
  });

  it('range whose anchor left the list falls back to a plain click', () => {
    const { ordered, sel } = setup();
    sel.select('b');
    ordered.value = ordered.value.filter((n) => n.id !== 'b');
    sel.select('d', { range: true });
    expect(ids(sel)).toEqual(['d']);
  });

  it('a chain of shift-clicks anchors each range at the previous shift-click', () => {
    const { sel } = setup();
    sel.select('a');
    sel.select('b', { range: true });
    expect(ids(sel)).toEqual(['a', 'b']);
    // From 'b', not from 'a': 'd' turns on, so b..d is added.
    sel.select('d', { range: true });
    expect(ids(sel)).toEqual(['a', 'b', 'c', 'd']);
    // From 'd': 'c' is selected, so it flips off and takes c..d with it.
    sel.select('c', { range: true });
    expect(ids(sel)).toEqual(['a', 'b']);
  });

  it('shift-click onto a selected item deselects the whole range', () => {
    const { sel } = setup();
    sel.select('a');
    sel.selectAll();
    sel.select('c', { range: true });
    expect(ids(sel)).toEqual(['d', 'e']);
  });

  it('shift-click on a checkbox extends the selection without dropping the rest', () => {
    const { sel } = setup();
    sel.select('e', { toggle: true });
    sel.select('a', { toggle: true });
    sel.select('c', { toggle: true, range: true });
    expect(ids(sel)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('ctrl-deselect moves the anchor to the clicked item', () => {
    const { sel } = setup();
    sel.select('a');
    sel.select('c', { toggle: true });
    sel.select('c', { toggle: true });
    expect(ids(sel)).toEqual(['a']);
    sel.select('e', { range: true });
    expect(ids(sel)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('range without an anchor behaves like a plain click', () => {
    const { sel } = setup();
    sel.select('c', { range: true });
    expect(ids(sel)).toEqual(['c']);
  });

  it('selectFromEvent maps ctrl/cmd to toggle and shift to range', () => {
    const { sel } = setup();
    sel.selectFromEvent('a', mouse());
    sel.selectFromEvent('c', mouse({ shiftKey: true }));
    expect(ids(sel)).toEqual(['a', 'b', 'c']);
    sel.selectFromEvent('b', mouse({ ctrlKey: true }));
    expect(ids(sel)).toEqual(['a', 'c']);
    sel.selectFromEvent('e', mouse({ metaKey: true }));
    expect(ids(sel)).toEqual(['a', 'c', 'e']);
    sel.selectFromEvent('d', mouse());
    expect(ids(sel)).toEqual(['d']);
  });

  it('select all / clear drive the header checkbox state', () => {
    const { sel } = setup();
    expect(sel.allState.value).toBe('none');
    sel.select('a');
    expect(sel.allState.value).toBe('some');
    sel.selectAll();
    expect(sel.allState.value).toBe('all');
    expect(ids(sel)).toHaveLength(5);
    sel.clear();
    expect(sel.allState.value).toBe('none');
  });

  it('keyboard: arrows move focus without selecting, space toggles, enter opens', () => {
    const { sel } = setup();
    const opened: string[] = [];
    const open = { open: (item: Item) => opened.push(item.id) };
    sel.handleKeydown(key('ArrowDown'), open);
    expect(sel.focusedId.value).toBe('a');
    expect(sel.cursorId.value).toBe('a');
    expect(ids(sel)).toEqual([]);
    sel.handleKeydown(key('ArrowDown'), open);
    sel.handleKeydown(key(' '), open);
    expect(ids(sel)).toEqual(['b']);
    sel.handleKeydown(key('ArrowUp'), open);
    sel.handleKeydown(key('ArrowUp'), open);
    expect(sel.focusedId.value).toBe('a');
    sel.handleKeydown(key('Enter'), open);
    expect(opened).toEqual(['a']);
  });

  it('moveFocus clamps at both ends and starts from the nearest end', () => {
    const { sel } = setup(['a', 'b']);
    sel.moveFocus(-1);
    expect(sel.focusedId.value).toBe('b');
    sel.moveFocus(1);
    expect(sel.focusedId.value).toBe('b');
    sel.moveFocus(-1);
    sel.moveFocus(-1);
    expect(sel.focusedId.value).toBe('a');
  });

  it('empty list: arrows keep the cursor empty and space/enter are not consumed', () => {
    const { sel } = setup([]);
    expect(sel.handleKeydown(key('ArrowDown'), noop)).toBe(true);
    expect(sel.focusedId.value).toBeNull();
    expect(sel.handleKeydown(key(' '), noop)).toBe(false);
    expect(sel.handleKeydown(key('Enter'), noop)).toBe(false);
    expect(sel.allState.value).toBe('none');
  });

  it('space and enter without a cursor are not consumed', () => {
    const { sel } = setup();
    const opened: Item[] = [];
    expect(sel.handleKeydown(key(' '), noop)).toBe(false);
    expect(sel.handleKeydown(key('Enter'), { open: (item) => opened.push(item) })).toBe(false);
    expect(ids(sel)).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('a mouse click hides the cursor ring; escape clears it too', () => {
    const { sel } = setup();
    sel.handleKeydown(key('ArrowDown'), noop);
    expect(sel.cursorId.value).toBe('a');
    sel.selectFromEvent('c', mouse());
    expect(sel.focusedId.value).toBe('c');
    expect(sel.cursorId.value).toBeNull();
    sel.handleKeydown(key('ArrowDown'), noop);
    expect(sel.cursorId.value).toBe('d');
    sel.handleKeydown(key('Escape'), noop);
    expect(ids(sel)).toEqual([]);
    expect(sel.cursorId.value).toBeNull();
    expect(sel.focusedId.value).toBe('d');
  });

  it('keyboard: ctrl/cmd+a selects all by physical key, escape clears, plain a is ignored', () => {
    const { sel } = setup();
    expect(sel.handleKeydown(key('a'), noop)).toBe(false);
    expect(sel.handleKeydown(key('a', { ctrlKey: true }), noop)).toBe(true);
    expect(sel.allState.value).toBe('all');
    sel.handleKeydown(key('Escape'), noop);
    expect(ids(sel)).toEqual([]);
    // Russian layout: the key value is 'ф' but the physical key is still KeyA.
    expect(sel.handleKeydown(key('ф', { code: 'KeyA', ctrlKey: true }), noop)).toBe(true);
    expect(sel.allState.value).toBe('all');
    sel.clear();
    expect(sel.handleKeydown(key('ф', { code: 'KeyA' }), noop)).toBe(false);
    expect(sel.handleKeydown(key('a', { code: 'KeyQ', ctrlKey: true }), noop)).toBe(false);
    expect(sel.allState.value).toBe('none');
  });

  it('Delete addresses the selection (first item) or the cursor; F2 only a single target', () => {
    const { sel } = setup();
    const removed: string[] = [];
    const renamed: string[] = [];
    const on = { open: () => {}, remove: (item: Item) => removed.push(item.id), rename: (item: Item) => renamed.push(item.id) };
    // Nothing selected, no cursor: not consumed.
    expect(sel.handleKeydown(key('Delete'), on)).toBe(false);
    expect(sel.handleKeydown(key('F2'), on)).toBe(false);
    // Cursor only.
    sel.moveFocus(1);
    expect(sel.handleKeydown(key('Delete'), on)).toBe(true);
    expect(sel.handleKeydown(key('F2'), on)).toBe(true);
    expect(removed).toEqual(['a']);
    expect(renamed).toEqual(['a']);
    // Selection wins over the cursor; F2 refuses a multi-selection.
    sel.select('c');
    sel.select('d', { toggle: true });
    sel.moveFocus(-1);
    expect(sel.handleKeydown(key('Delete'), on)).toBe(true);
    expect(removed).toEqual(['a', 'c']);
    expect(sel.handleKeydown(key('F2'), on)).toBe(false);
    sel.select('d');
    expect(sel.handleKeydown(key('F2'), on)).toBe(true);
    expect(renamed).toEqual(['a', 'd']);
    // Without handlers the keys fall through.
    expect(sel.handleKeydown(key('Delete'), noop)).toBe(false);
    expect(sel.handleKeydown(key('F2'), noop)).toBe(false);
  });
});
