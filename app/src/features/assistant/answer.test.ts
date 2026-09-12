import { describe, expect, it } from 'vitest';
import { parseAnswer, parseSpans, plainAnswer, splitAddress } from './answer';

const text = (spans: ReturnType<typeof parseSpans>) => spans.map((s) => s.text).join('');

describe('parseAnswer', () => {
  it('reads paragraphs, headings and both kinds of list', () => {
    const blocks = parseAnswer('## Found\n\nTwo files:\n\n- one\n- two\n\n1. first\n2. second');
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'p', 'ul', 'ol']);
    expect(blocks[2]).toMatchObject({ items: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]] });
    expect(blocks[3]).toMatchObject({ kind: 'ol', start: 1 });
  });

  it('keeps a fenced block verbatim', () => {
    const blocks = parseAnswer('before\n\n```json\n{"a": **1**}\n```\n\nafter');
    expect(blocks[1]).toEqual({ kind: 'pre', text: '{"a": **1**}' });
  });

  // The panel re-parses on every streamed delta, so half a fence is the normal case.
  it('renders an unfinished fence rather than swallowing the answer', () => {
    expect(parseAnswer('here it is:\n\n```\nline one')).toEqual([
      { kind: 'p', spans: [{ kind: 'text', text: 'here it is:' }] },
      { kind: 'pre', text: 'line one' },
    ]);
  });

  it('folds a wrapped list item into the item it belongs to', () => {
    const blocks = parseAnswer('- a long item\n  continued here');
    expect(blocks).toHaveLength(1);
    expect(text((blocks[0] as { items: ReturnType<typeof parseSpans>[] }).items[0])).toBe('a long item continued here');
  });
});

describe('parseSpans', () => {
  it('finds bold, italic and code', () => {
    expect(parseSpans('a **b** c *d* e `f`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'em', text: 'd' },
      { kind: 'text', text: ' e ' },
      { kind: 'code', text: 'f' },
    ]);
  });

  // File names are most of what this panel says, and they are full of underscores.
  it('leaves underscores alone', () => {
    expect(parseSpans('my_report_v2.txt')).toEqual([{ kind: 'text', text: 'my_report_v2.txt' }]);
  });

  it('turns a bare address into a path, without the sentence it ends', () => {
    expect(parseSpans('It is in main://Docs/spec.pdf.')).toEqual([
      { kind: 'text', text: 'It is in ' },
      { kind: 'path', text: 'main://Docs/spec.pdf' },
      { kind: 'text', text: '.' },
    ]);
  });

  // A backticked address is how a path with spaces in it survives.
  it('reads a quoted address as a path, spaces and all', () => {
    expect(parseSpans('`main://My Folder/q1 report.pdf`')).toEqual([{ kind: 'path', text: 'main://My Folder/q1 report.pdf' }]);
  });

  it('keeps a web address a link and an address a path', () => {
    expect(parseSpans('https://filex.sh and main://a')).toEqual([
      { kind: 'link', text: 'https://filex.sh', href: 'https://filex.sh' },
      { kind: 'text', text: ' and ' },
      { kind: 'path', text: 'main://a' },
    ]);
  });

  // ⚠ The model's output is shaped by files other people wrote.
  it('refuses to make a link out of a scheme that is not the web', () => {
    expect(text(parseSpans('[click me](javascript:alert(1))'))).toBe('click me (javascript:alert(1))');
    expect(parseSpans('[click me](javascript:alert(1))').every((s) => s.kind === 'text')).toBe(true);
    expect(parseSpans('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });

  it('reads a markdown link', () => {
    expect(parseSpans('see [the docs](https://docs.filex.sh/ASSISTANT)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the docs', href: 'https://docs.filex.sh/ASSISTANT' },
    ]);
  });
});

describe('splitAddress', () => {
  it('splits a drive off an address', () => {
    expect(splitAddress('main://Docs/spec.pdf')).toEqual({ drive: 'main', path: 'Docs/spec.pdf' });
    expect(splitAddress('main://')).toEqual({ drive: 'main', path: '' });
    expect(splitAddress('Docs/spec.pdf')).toBeNull();
  });
});

describe('plainAnswer', () => {
  // What the screen reader hears: the words, not the markers.
  it('drops the markup', () => {
    expect(plainAnswer('## Found\n\n- **one** in `main://a`\n- two')).toBe('Found\none in main://a\ntwo');
  });
});
