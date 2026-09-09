import { describe, expect, it } from 'vitest';
import {
  fromFileNode,
  fromModelNode,
  fromTrashEntry,
  joinPath,
  nameOf,
  parentPath,
  SMALL_IMAGE_BYTES,
  splitPath,
  toQuota,
  toStorage,
  type WireFileNode,
  type WireNode,
} from './map';

const listed = (patch: Partial<WireFileNode> = {}): WireFileNode => ({
  id: 42,
  path: 'main://Docs/report.pdf',
  basename: 'report.pdf',
  type: 'file',
  extension: 'pdf',
  size: 2048,
  mime_type: 'application/pdf',
  storage: 'main',
  last_modified: Date.parse('2026-07-01T10:00:00Z'),
  ...patch,
});

describe('addressing', () => {
  it('splits and rejoins an adapter-qualified path, tolerating stray slashes', () => {
    expect(splitPath('main://Docs/report.pdf')).toEqual({ adapter: 'main', rel: 'Docs/report.pdf' });
    expect(splitPath('main://')).toEqual({ adapter: 'main', rel: '' });
    expect(joinPath('main', '/Docs/')).toBe('main://Docs');
    expect(joinPath('main', '')).toBe('main://');
  });

  it('walks up to the storage root and stops there', () => {
    expect(parentPath('main://Docs/2026/report.pdf')).toBe('main://Docs/2026');
    expect(parentPath('main://Docs')).toBe('main://');
    expect(parentPath('main://')).toBeNull();
  });

  it('reads the basename off an address', () => {
    expect(nameOf('main://Docs/report.pdf')).toBe('report.pdf');
    expect(nameOf('main://')).toBe('');
  });
});

describe('listing rows → app model', () => {
  it('takes the address as the id and derives the parent from it', () => {
    expect(fromFileNode(listed())).toMatchObject({
      id: 'main://Docs/report.pdf',
      name: 'report.pdf',
      parentId: 'main://Docs',
      kind: 'file',
      size: 2048,
      fileType: 'pdf',
      thumbnail: 'pdf',
      modifiedAt: '2026-07-01T10:00:00.000Z',
    });
  });

  it('serves a file’s bytes through the endpoint that listed it, so no node id is needed', () => {
    expect(fromFileNode(listed()).assetUrl).toBe('/api/files/manager?q=preview&path=main%3A%2F%2FDocs%2Freport.pdf');
  });

  it('gives a folder no size and no bytes', () => {
    const folder = fromFileNode(listed({ type: 'dir', path: 'main://Docs', basename: 'Docs', size: 4096 }));
    expect(folder).toMatchObject({ kind: 'folder', size: 0, parentId: 'main://' });
    expect(folder.assetUrl).toBeUndefined();
    expect(folder.fileType).toBeUndefined();
  });

  it('treats a symlink as the file it stands for', () => {
    expect(fromFileNode(listed({ type: 'symlink' })).kind).toBe('file');
  });

  it('sorts a dateless row last rather than as an invalid date', () => {
    expect(fromFileNode(listed({ last_modified: undefined })).modifiedAt).toBeUndefined();
  });

  it('points the tile at the cached thumbnail, versioned by mtime, and at nothing when the server has none', () => {
    const thumbed = fromFileNode(listed({ thumb_url: '/api/files/thumb/42' }));
    expect(thumbed.thumbUrl).toBe(`/api/files/thumb/42?v=${Date.parse('2026-07-01T10:00:00Z')}`);
    expect(fromFileNode(listed({ thumb_url: '/api/files/thumb/42', last_modified: undefined })).thumbUrl).toBe('/api/files/thumb/42');
    expect(fromFileNode(listed()).thumbUrl).toBeUndefined();
  });

  it('ignores the server’s extension card for types the app draws itself', () => {
    // README.md would arrive with a thumb_url: the pipeline paints a coloured card with "MD" on it for any file it
    // cannot render. The app has its own document art, so the card is not shown.
    const md = listed({ path: 'main://Docs/README.md', basename: 'README.md', extension: 'md', thumb_url: '/api/files/thumb/42' });
    expect(fromFileNode(md).thumbUrl).toBeUndefined();
    expect(fromFileNode(md).thumbnail).toBe('document');
    expect(fromFileNode(listed({ path: 'main://Docs/clip.mp4', basename: 'clip.mp4', extension: 'mp4', thumb_url: '/api/files/thumb/42' })).thumbUrl).toBe(
      `/api/files/thumb/42?v=${Date.parse('2026-07-01T10:00:00Z')}`,
    );
  });

  it('lets a small image be its own tile, and a large one wait for the server', () => {
    const photo = (size: number) => listed({ path: 'main://Docs/photo.webp', basename: 'photo.webp', extension: 'webp', size });
    expect(fromFileNode(photo(SMALL_IMAGE_BYTES - 1)).thumbUrl).toBe('/api/files/manager?q=preview&path=main%3A%2F%2FDocs%2Fphoto.webp');
    expect(fromFileNode(photo(SMALL_IMAGE_BYTES)).thumbUrl).toBeUndefined();
    expect(fromFileNode(photo(0)).thumbUrl).toBeUndefined();
    // A small file that is not an image has no tile of its own.
    expect(fromFileNode(listed({ size: 10 })).thumbUrl).toBeUndefined();
  });

  it('leaves starred off: it is per-user metadata a listing row does not carry', () => {
    expect(fromFileNode(listed())).toMatchObject({ starred: false });
  });

  it('takes shared from the row, and reads a missing flag as not shared', () => {
    expect(fromFileNode(listed({ shared: true })).shared).toBe(true);
    expect(fromFileNode(listed()).shared).toBe(false);
  });

  it('counts a folder only when the server counted it: no count is not zero items', () => {
    const dir = listed({ type: 'dir', path: 'main://Docs', basename: 'Docs' });
    expect(fromFileNode({ ...dir, item_count: 12 }).itemCount).toBe(12);
    expect(fromFileNode({ ...dir, item_count: 0 }).itemCount).toBe(0);
    expect(fromFileNode(dir).itemCount).toBeUndefined();
  });

  it('dates the row from created_at, and omits the field where the server sent none', () => {
    expect(fromFileNode(listed({ created_at: Date.parse('2026-06-02T08:30:00Z') })).createdAt).toBe('2026-06-02T08:30:00.000Z');
    expect(fromFileNode(listed()).createdAt).toBeUndefined();
  });
});

describe('metadata rows → app model', () => {
  const model = (patch: Partial<WireNode> = {}): WireNode => ({
    id: 7,
    storage_id: 1,
    name: 'notes.md',
    path: '/Docs/notes.md',
    type: 'file',
    size: 12,
    db_mtime: '2026-07-01T10:00:00Z',
    created_at: '2026-06-01T09:00:00Z',
    storage: 'main',
    ...patch,
  });

  it('rebuilds the address from the storage name the endpoint attaches', () => {
    expect(fromModelNode(model(), 'main')).toMatchObject({
      id: 'main://Docs/notes.md',
      parentId: 'main://Docs',
      createdAt: '2026-06-01T09:00:00Z',
    });
  });

  it('prefers the driver mtime over filex’s own cached one', () => {
    expect(fromModelNode(model({ backend_mtime: '2026-07-09T08:00:00Z' }), 'main').modifiedAt).toBe('2026-07-09T08:00:00Z');
    expect(fromModelNode(model({ backend_mtime: null }), 'main').modifiedAt).toBe('2026-07-01T10:00:00Z');
  });

  it('carries the trash timestamp only when there is one', () => {
    expect(fromModelNode(model(), 'main').deletedAt).toBeUndefined();
    expect(fromModelNode(model({ deleted_at: '2026-07-10T12:00:00Z' }), 'main').deletedAt).toBe('2026-07-10T12:00:00Z');
  });

  it('builds the thumbnail address from the node id, only once the pipeline reports it ready', () => {
    const photo = (patch: Partial<WireNode> = {}) => model({ name: 'photo.jpg', path: '/Docs/photo.jpg', size: 4 << 20, ...patch });
    expect(fromModelNode(photo({ thumb: { state: 'ready' } }), 'main').thumbUrl).toBe('/api/files/thumb/7?v=2026-07-01T10%3A00%3A00Z');
    expect(fromModelNode(photo({ thumb: { state: 'pending' } }), 'main').thumbUrl).toBeUndefined();
    expect(fromModelNode(photo(), 'main').thumbUrl).toBeUndefined();
    expect(fromModelNode(photo({ type: 'dir', thumb: { state: 'ready' } }), 'main').thumbUrl).toBeUndefined();
    // The server's extension card for a markdown file is not a picture of it; the app's document art shows instead.
    expect(fromModelNode(model({ thumb: { state: 'ready' } }), 'main').thumbUrl).toBeUndefined();
    // A small image is its own tile here too, whatever the pipeline said about it.
    expect(fromModelNode(model({ name: 'photo.jpg', path: '/Docs/photo.jpg', size: 1024, thumb: { state: 'skipped' } }), 'main').thumbUrl).toBe(
      '/api/files/manager?q=preview&path=main%3A%2F%2FDocs%2Fphoto.jpg',
    );
  });

  it('carries the share flag, so a starred or recently-opened row badges like a listed one', () => {
    expect(fromModelNode(model({ shared: true }), 'main').shared).toBe(true);
    expect(fromModelNode(model(), 'main').shared).toBe(false);
  });
});

describe('trash rows → app model', () => {
  it('shows where the node came from and dates the row by its deletion', () => {
    const node = fromTrashEntry({
      id: 9,
      storage_id: 1,
      storage_name: 'main',
      path: '/Design/logo.svg',
      name: 'logo.svg',
      size: 900,
      deleted_at: '2026-07-10T12:00:00Z',
    });
    expect(node).toMatchObject({
      id: 'main://Design/logo.svg',
      originalPath: '/Design',
      deletedAt: '2026-07-10T12:00:00Z',
      modifiedAt: '2026-07-10T12:00:00Z',
    });
  });
});

describe('storages', () => {
  it('is addressed by its name, and its root is the bare adapter form', () => {
    const storage = toStorage({ name: 'main', read_only: false, used_bytes: 100 }, 1000);
    expect(storage).toEqual({ id: 'main', name: 'main', rootId: 'main://', quota: { usedBytes: 100, totalBytes: 1000 }, shared: false });
  });

  it('measures the drive’s own bytes against the account ceiling, not the account’s bytes against it', () => {
    const [main, backup] = [
      toStorage({ name: 'main', read_only: false, used_bytes: 300 }, 1000),
      toStorage({ name: 'backup', read_only: true, used_bytes: 700 }, 1000),
    ];
    expect([main.quota.usedBytes, backup.quota.usedBytes]).toEqual([300, 700]);
    // A server too old to report it says nothing rather than repeating the account's figure under every drive.
    expect(toStorage({ name: 'old', read_only: false }, 1000).quota.usedBytes).toBe(0);
  });

  it('shows an unlimited account as no ceiling rather than a bar that never fills', () => {
    expect(toQuota({ used_bytes: 5, quota_bytes: 0, unlimited: true })).toEqual({ usedBytes: 5, totalBytes: 0 });
    expect(toQuota({ used_bytes: 5, quota_bytes: 50 })).toEqual({ usedBytes: 5, totalBytes: 50 });
  });
});
