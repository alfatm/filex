import { describe, expect, it } from 'vitest';
import { isInside, joinPath, nameOf, parentPath, splitPath } from './address';

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

  it('reads containment off the address alone, at any depth, and never of itself', () => {
    expect(isInside('main://Docs/2026/report.pdf', 'main://Docs')).toBe(true);
    expect(isInside('main://Docs/report.pdf', 'main://')).toBe(true);
    expect(isInside('main://Docs', 'main://Docs')).toBe(false);
    expect(isInside('main://Documents/a.txt', 'main://Docs')).toBe(false);
  });
});
