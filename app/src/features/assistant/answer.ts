/**
 * The assistant answers in Markdown — and Markdown from a language model is
 * UNTRUSTED text: what it says can be shaped by a file it just read, and files
 * are written by other people.
 *
 * So the answer is parsed here into a small token tree that the panel renders
 * with real elements. There is no `v-html` anywhere in the assistant and no
 * sanitiser to get wrong: a parser that knows five blocks and five spans has
 * nothing to be tricked into emitting. It also means the parser may be
 * incomplete without being unsafe — anything it does not recognise stays
 * visible as the characters the model wrote.
 *
 * ⚠ Underscores are deliberately NOT italics. `my_report_v2.txt` is a file
 * name, and file names are most of what this panel talks about.
 */

/** One piece of a line. */
export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  /** A file address, `storage://folder/file` — the panel makes it clickable. */
  | { kind: 'path'; text: string }
  | { kind: 'link'; text: string; href: string };

/** One block of an answer. */
export type Block =
  | { kind: 'p'; spans: Span[] }
  /** `level` is the number of `#`, 1–6 — a document preview sizes its headings by it. */
  | { kind: 'h'; level: number; spans: Span[] }
  | { kind: 'ul'; items: Span[][] }
  | { kind: 'ol'; items: Span[][]; start: number }
  | { kind: 'pre'; text: string };

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;

/**
 * Inline syntax, tried left to right at every position: a code span, a
 * `[text](url)` link, bold, italic, then a bare address or URL. Code wins over
 * everything else, which is what lets a path with spaces in it be written
 * `main://My Folder/spec.pdf` and still arrive in one piece.
 */
const INLINE = /(`+)([^`]+?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|([A-Za-z0-9][A-Za-z0-9_.+-]*:\/\/[^\s`<>[\]()]+)/;

/** An address is a scheme and something after it; a drive name is the scheme. */
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9_.+-]*:\/\/\S/;
/** Trailing sentence punctuation belongs to the sentence, not to the path. */
const TRAILING = /[.,;:!?)\]]+$/;

/** Parses one answer. Partial input is fine: this runs on every streamed delta. */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', spans: parseSpans(paragraph.join('\n')) });
    paragraph = [];
    if (list) blocks.push(list.ordered ? { kind: 'ol', start: list.start, items: list.items.map(parseSpans) } : { kind: 'ul', items: list.items.map(parseSpans) });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A fence runs to the closing one, or — mid-stream — to the end of what has arrived.
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ kind: 'pre', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'h', level: heading[1].length, spans: parseSpans(heading[2]) });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    const bullet = numbered ? null : BULLET.exec(line);
    if (numbered || bullet) {
      if (paragraph.length) flush();
      const ordered = !!numbered;
      // A list that changes marker starts a new list rather than mixing the two.
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(numbered ? numbered[2] : bullet![1]);
      continue;
    }
    // A plain line under a list item is that item's continuation, not a new paragraph.
    if (list) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Splits one line into spans. */
export function parseSpans(text: string): Span[] {
  const out: Span[] = [];
  let rest = text;
  const push = (span: Span) => {
    if (span.kind === 'text' && !span.text) return;
    out.push(span);
  };
  for (;;) {
    const match = INLINE.exec(rest);
    if (!match) break;
    push({ kind: 'text', text: rest.slice(0, match.index) });
    const [whole, , code, linkText, href, strong, em, bare] = match;
    if (code !== undefined) push(ADDRESS.test(code.trim()) ? { kind: 'path', text: code.trim() } : { kind: 'code', text: code });
    else if (linkText !== undefined) push(webLink(linkText, href));
    else if (strong !== undefined) push({ kind: 'strong', text: strong });
    else if (em !== undefined) push({ kind: 'em', text: em });
    else if (bare !== undefined) {
      const trimmed = bare.replace(TRAILING, '');
      push(isWeb(trimmed) ? { kind: 'link', text: trimmed, href: trimmed } : { kind: 'path', text: trimmed });
      rest = rest.slice(match.index + trimmed.length);
      continue;
    }
    rest = rest.slice(match.index + whole.length);
  }
  push({ kind: 'text', text: rest });
  return out;
}

function isWeb(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * ⚠ A link the model wrote is a link somebody else may have written. Only
 * http(s) survives as a link; `javascript:` and friends are shown as the text
 * they are, which is both safer and more honest than dropping them silently.
 */
function webLink(text: string, href: string): Span {
  return isWeb(href) ? { kind: 'link', text, href } : { kind: 'text', text: `${text} (${href})` };
}

/** The drive and the rest of a `drive://folder/file` address, or null. */
export function splitAddress(address: string): { drive: string; path: string } | null {
  const at = address.indexOf('://');
  if (at <= 0) return null;
  return { drive: address.slice(0, at), path: address.slice(at + 3) };
}

/**
 * The answer as it sounds read aloud. The panel announces a finished answer to
 * screen readers, and the announcement is text, not layout: `##` and `**` are
 * markers for the eye and noise for the ear.
 */
export function plainAnswer(text: string): string {
  const line = (spans: Span[]) => spans.map((s) => s.text).join('');
  return parseAnswer(text)
    .map((block) => {
      if (block.kind === 'pre') return block.text;
      if (block.kind === 'ul' || block.kind === 'ol') return block.items.map(line).join('\n');
      return line(block.spans);
    })
    .join('\n');
}
