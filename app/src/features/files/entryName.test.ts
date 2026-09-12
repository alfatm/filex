import { describe, expect, it } from 'vitest';
import { isValidEntryName } from './entryName';

// The client's copy of the server's rule (`validEntryName` in manager_mutate.go). The two are asserted over the
// same names on both sides on purpose: a dialog that refuses MORE than the server would make an existing file
// unrenameable, and one that refuses less sends a request that comes back saying something else entirely — which
// is what `..` did, arriving as "That name is already taken".
describe('isValidEntryName', () => {
  it('takes every name a folder can hold', () => {
    for (const name of ['notes', 'a b', '..hidden', '...', 'файл.txt', 'a..b', 'why:me*?', 'a"b<c>d|e']) {
      expect(isValidEntryName(name), name).toBe(true);
    }
  });

  it('refuses what addresses a folder instead of an entry in one', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', '/', '../x']) {
      expect(isValidEntryName(name), name).toBe(false);
    }
  });
});
