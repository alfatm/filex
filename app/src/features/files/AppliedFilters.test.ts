import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repository } from '@/data';
import { i18n } from '@/i18n';
import { useFilesStore } from '@/stores/files';
import AppliedFilters from './AppliedFilters.vue';
import { emptyFilter } from './filters';

const WINDOW = { field: 'modified', at: '2026-09-09T12:00:00Z', span: 'day' } as const;

/** The chip bodies (the buttons that open a menu), in the order they are drawn. */
function bodies(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button[aria-haspopup="menu"]');
}

/** The remove buttons beside them. */
function crosses(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').filter((button) => button.attributes('aria-label') === 'Remove this filter');
}

describe('the filters that have no chip of their own', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = 'en';
    vi.spyOn(repository, 'listAllTags').mockResolvedValue(['design', 'q3', 'archive']);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function chips() {
    const files = useFilesStore();
    files.filter = { ...emptyFilter(), tags: ['design'], around: { ...WINDOW } };
    return { files, wrapper: mount(AppliedFilters, { global: { plugins: [i18n] }, attachTo: document.body }) };
  }

  it('shows the value, not a sentence, and removes the filter from the cross alone', async () => {
    const { files, wrapper } = chips();
    expect(bodies(wrapper)).toHaveLength(2);
    expect(bodies(wrapper)[0].text()).toBe('Sep 9, 2026 ±1d');
    expect(bodies(wrapper)[0].attributes('title')).toBe('Modified within a day of Sep 9, 2026');
    expect(bodies(wrapper)[1].text()).toBe('#design');

    await crosses(wrapper)[0].trigger('click');
    expect(files.filter.around).toBeNull();
    await crosses(wrapper)[0].trigger('click');
    expect(files.filter.tags).toEqual([]);
    expect(bodies(wrapper)).toHaveLength(0);
  });

  it('edits the date window from its own menu: which date it reads and how wide it is', async () => {
    const { files, wrapper } = chips();
    await bodies(wrapper)[0].trigger('click');
    const items = document.querySelectorAll('[role="menu"] [role="menuitemradio"]');
    expect([...items].map((item) => item.textContent?.trim())).toEqual(['Modified date', 'Created date', '±1 hour', '±1 day', '±1 week']);

    await (items[1] as HTMLElement).click();
    await flushPromises();
    expect(files.filter.around).toEqual({ ...WINDOW, field: 'created' });

    await bodies(wrapper)[0].trigger('click');
    await (document.querySelectorAll('[role="menu"] [role="menuitemradio"]')[4] as HTMLElement).click();
    await flushPromises();
    expect(files.filter.around).toEqual({ ...WINDOW, field: 'created', span: 'week' });
  });

  it('swaps one tag for another from the drive’s own list, leaving the other tags alone', async () => {
    const files = useFilesStore();
    files.filter = { ...emptyFilter(), tags: ['design', 'q3'] };
    const wrapper = mount(AppliedFilters, { global: { plugins: [i18n] }, attachTo: document.body });

    await bodies(wrapper)[0].trigger('click');
    await flushPromises();
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')] as HTMLElement[];
    expect(items.map((item) => item.textContent?.trim())).toEqual(['design', 'q3', 'archive']);
    // The tag the OTHER chip holds is offered but inert: two chips for one tag is not a filter.
    expect(items[1].getAttribute('aria-disabled')).toBe('true');

    items[2].click();
    await flushPromises();
    expect(files.filter.tags).toEqual(['archive', 'q3']);
  });
});
