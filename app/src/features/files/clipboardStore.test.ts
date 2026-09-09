import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import type { Composer } from 'vue-i18n';
import { resetMock } from '@/data/mock';
import { noCapabilities, type Capabilities } from '@/data/types';
import { listingMenuEntries } from '@/pages/files/itemMenu';
import { useCapabilitiesStore } from '@/stores/capabilities';
import { useFilesStore } from '@/stores/files';
import { useClipboardStore } from './clipboardStore';

/** The entries carry their own labels; what is under test here is which of them are offered. */
const label = ((key: string) => key) as unknown as Composer['t'];

/** A folder listing (so pasting has somewhere to land) on a server offering exactly `can`. */
async function setup(can: Partial<Capabilities>) {
  resetMock();
  setActivePinia(createPinia());
  useCapabilitiesStore().can = { ...noCapabilities(), ...can };
  const files = useFilesStore();
  await files.bootstrap();
  await files.openPath('demo', '');
  return { files, clipboard: useClipboardStore(), node: files.ordered[0] };
}

describe('clipboard capabilities', () => {
  // The keyboard filled the clipboard with no regard for what the server offers, while the menu entries behind the
  // same two verbs were greyed out: Ctrl+X then armed a paste the server was always going to refuse.
  it('takes nothing when the server has no move behind a cut, and none when it has no copy', async () => {
    const cutOnly = await setup({ move: true, copy: false });
    cutOnly.clipboard.copy([cutOnly.node]);
    expect(cutOnly.clipboard.nodes).toHaveLength(0);
    cutOnly.clipboard.cut([cutOnly.node]);
    expect(cutOnly.clipboard.nodes).toHaveLength(1);

    const copyOnly = await setup({ move: false, copy: true });
    copyOnly.clipboard.cut([copyOnly.node]);
    expect(copyOnly.clipboard.nodes).toHaveLength(0);
    copyOnly.clipboard.copy([copyOnly.node]);
    expect(copyOnly.clipboard.nodes).toHaveLength(1);
  });

  // Paste was gated on `move` in both modes, so a server that copies but does not move refused to paste a copy.
  it('offers a paste after a copy on a server that copies but does not move', async () => {
    const { clipboard, node } = await setup({ move: false, copy: true });
    clipboard.copy([node]);
    expect(clipboard.canPaste).toBe(true);

    const paste = listingMenuEntries(label, useCapabilitiesStore().can, {
      canCreate: true,
      canPaste: clipboard.canPaste,
      canSelectAll: true,
      hasSelection: false,
    }).find((entry) => entry.id === 'paste');
    expect(paste?.disabled).toBeFalsy();
  });

  it('offers no paste at all where neither verb is there', async () => {
    const { clipboard, node } = await setup({});
    clipboard.copy([node]);
    clipboard.cut([node]);
    expect(clipboard.canPaste).toBe(false);
  });
});
