// Snapshots the demo asset tree into src/data/mock/tree.json, the source of the mock dataset.
//
//   pnpm --filter ./app gen:demo
//   DEMO_ASSETS_DIR=/somewhere/demo pnpm --filter ./app gen:demo
//
// The tree lives in a sibling repository (drive-demo-assets); the default location is
// ../../drive-demo-assets/demo relative to app/. The output is committed: paths are relative to the
// assets root, entries are sorted, and text-like files carry a short excerpt so content search and the
// assistant snippets have something to match against. Dotfiles are skipped.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const ASSETS_DIR = path.resolve(APP_DIR, process.env.DEMO_ASSETS_DIR ?? '../../drive-demo-assets/demo');
const OUT_FILE = path.join(APP_DIR, 'src/data/mock/tree.json');

const TEXT_MAX_BYTES = 200 * 1024;
const EXCERPT_BYTES = 2 * 1024;

const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  psd: 'image/vnd.adobe.photoshop',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  rtf: 'text/rtf',
  html: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  ts: 'text/typescript',
  go: 'text/x-go',
  py: 'text/x-python',
  sql: 'text/x-sql',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  fig: 'application/octet-stream',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  jar: 'application/java-archive',
  iso: 'application/x-iso9660-image',
  sqlite: 'application/vnd.sqlite3',
};
/** Files without an extension that are still plain text. */
const TEXT_NAMES = new Set(['Dockerfile']);
const TEXT_MIMES = new Set(['application/json']);

function mimeOf(name) {
  if (TEXT_NAMES.has(name)) return 'text/plain';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** First 2 KB of a text-like file, or null when it is too large or turns out to be binary. */
function excerpt(file, mime, size) {
  if (size > TEXT_MAX_BYTES || !(mime.startsWith('text/') || TEXT_MIMES.has(mime))) return null;
  const buffer = readFileSync(file).subarray(0, EXCERPT_BYTES);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8').replace(/�$/, '');
}

/** Appends the entries below `dir` to `out` and returns them. */
function walk(dir, relative, out) {
  const start = out.length;
  // Byte-order sort keeps the output identical across locales.
  const names = readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = statSync(file);
    const entryPath = relative ? `${relative}/${name}` : name;
    if (stat.isDirectory()) {
      // A folder's own mtime is the checkout time; the newest child keeps the output stable across clones.
      const folder = { path: entryPath, kind: 'folder', size: 0, mtime: '', mime: 'inode/directory' };
      out.push(folder);
      const children = walk(file, entryPath, out);
      folder.mtime = children.map((e) => e.mtime).sort().at(-1) ?? stat.mtime.toISOString();
    } else if (stat.isFile()) {
      const mime = mimeOf(name);
      const text = excerpt(file, mime, stat.size);
      out.push({ path: entryPath, kind: 'file', size: stat.size, mtime: stat.mtime.toISOString(), mime, ...(text !== null && { text }) });
    }
  }
  return out.slice(start);
}

let root;
try {
  root = statSync(ASSETS_DIR);
} catch {
  console.error(`demo assets not found at ${ASSETS_DIR} (set DEMO_ASSETS_DIR)`);
  process.exit(1);
}
if (!root.isDirectory()) {
  console.error(`${ASSETS_DIR} is not a directory`);
  process.exit(1);
}

const entries = [];
walk(ASSETS_DIR, '', entries);
writeFileSync(OUT_FILE, `${JSON.stringify(entries, null, 2)}\n`);
const files = entries.filter((e) => e.kind === 'file');
console.log(`${OUT_FILE}: ${files.length} files, ${entries.length - files.length} folders, ${files.filter((e) => e.text).length} with text`);
