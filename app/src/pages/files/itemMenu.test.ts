import { describe, expect, it } from 'vitest';
import type { Composer } from 'vue-i18n';
import { noCapabilities, ROLE_PERMISSIONS, type Capabilities, type Node } from '@/data/types';
import { i18n } from '@/i18n';
import { itemMenuEntries, listingMenuEntries } from './itemMenu';

// The menus take the component-scoped translator's type; the global one is the same function, narrower in its locales.
const t = i18n.global.t as Composer['t'];

/** Everything the installation offers, and every permission the role carries unless one is taken away. */
const can = (patch: Partial<Capabilities> = {}, withheld: string[] = []): Capabilities => ({
  ...noCapabilities(),
  upload: true,
  move: true,
  copy: true,
  delete: true,
  mkdir: true,
  search: true,
  versions: true,
  tags: true,
  permissions: true,
  deleteForever: true,
  folderDownload: true,
  allowed: new Set(ROLE_PERMISSIONS.filter((id) => !withheld.includes(id))),
  ...patch,
});

const file: Node = { id: 'demo://Docs/a.md', name: 'a.md', kind: 'file', parentId: 'demo://Docs', size: 1, ownerId: 'u1', shared: false, starred: false };

const entry = (entries: ReturnType<typeof itemMenuEntries>, id: string) => entries.find((e) => e.id === id)!;

describe('the item menu under role permissions', () => {
  it('leaves every entry alone for a role that carries the lot', () => {
    const entries = itemMenuEntries(t, file, can());
    expect(entries.filter((e) => e.disabled).map((e) => e.id)).toEqual([]);
  });

  /*
   * Two refusals, two sentences. "Not available on this server" is about the installation and nobody in the
   * building can change it; "Your role may not do this" is about a rule an administrator set, and saying the first
   * one for the second sends the person to the wrong place.
   */
  it('says the role is the reason when the role is the reason, and the server when the server is', () => {
    const withheld = itemMenuEntries(t, file, can({}, ['files.move', 'files.delete']));
    expect(entry(withheld, 'moveTo')).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
    expect(entry(withheld, 'cut')).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
    expect(entry(withheld, 'moveToTrash')).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
    expect(entry(withheld, 'copyTo').disabled).toBeUndefined();

    // The installation is asked first: a feature the server does not have is not a role problem.
    const unsupported = itemMenuEntries(t, file, can({ move: false }, ['files.move']));
    expect(entry(unsupported, 'moveTo').hint).toBe(t('common.unavailable'));
  });

  it('gates sharing, tags, starring and managing access on their own permissions', () => {
    const entries = itemMenuEntries(t, file, can({}, ['files.share', 'files.tags', 'files.star', 'files.grant']));
    for (const id of ['share', 'tags', 'addToStarred', 'manageAccess']) {
      expect(entry(entries, id)).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
    }
  });

  // Restoring and purging are separate permissions, and the trash menu is the one place both appear at once.
  it('gates the trash menu on restore and purge separately', () => {
    const entries = itemMenuEntries(t, { ...file, deletedAt: '2026-07-01T00:00:00Z' }, can({}, ['files.purge']));
    expect(entry(entries, 'restore').disabled).toBeUndefined();
    expect(entry(entries, 'deleteForever')).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
  });

  it('gates the bare-surface menu’s New folder, New file and upload the same way', () => {
    const state = { canCreate: true, canPaste: false, canSelectAll: true, hasSelection: false };
    const entries = listingMenuEntries(t, can({}, ['files.upload']), state);
    expect(entry(entries, 'newFolder').disabled).toBeUndefined();
    expect(entry(entries, 'newFile')).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
    expect(entry(entries, 'fileUpload')).toMatchObject({ disabled: true, hint: t('common.notAllowed') });
  });
});
