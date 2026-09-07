# Demo assets

The mock repository (`src/data/mock/`) lists a real directory of demo files instead of a hand-written
list. The directory lives in a sibling repository, `drive-demo-assets`, whose `demo/` tree was built to
match the reference screenshots (spec §8): eight folders and eight files at the root, 142 files in all.

## Location

| What | Default | Override |
| --- | --- | --- |
| Asset directory | `../../drive-demo-assets/demo` (relative to `app/`) | `DEMO_ASSETS_DIR=/path/to/demo` |

The env var is read by the generator and by the Vite plugin (`vite.config.ts`). When the directory is
missing, dev and build still work: the plugin logs one warning, image requests 404 and the cards fall
back to the SVG/CSS placeholders.

## Generator: `pnpm --filter ./app gen:demo`

`scripts/gen-demo-tree.mjs` walks the directory and writes `src/data/mock/tree.json`, one entry per
folder and file: `{ path, kind, size, mtime, mime }`, plus `text` (the first 2 KB) for text-like files up
to 200 KB. Dotfiles are skipped, entries are sorted byte-wise, paths are relative to the asset root, so
the file is committed. Folder `mtime` is the newest child's, not the checkout time. Re-run it whenever the
asset tree changes.

`dataset.ts` turns the entries into `Node`s: ids are the slugged path (`Design/logo.svg` →
`design/logo-svg`), folder item counts are the number of real children, `contentIndex` is built from the
`text` excerpts, and every file node carries `assetUrl` (`/app/demo-assets/<path>`).

## Reference overrides

The 16 root entries keep the spec §8 dates, sizes and annotations through the `REF_OVERRIDES` table in
`dataset.ts` (e.g. `mountains.jpg` shows 12 MB although the file is 246 KB; `demo.mp4` carries the
"02:14" label until the browser reads the real duration). Everything below the root uses the real size;
its date is the parent's reference date minus one hour per position in the folder, so Recent's day groups
are deterministic.

Two more mock-only annotations sit on top of the tree:

- the three shared-with-me nodes inside `/demo/Shared` (`sharedWithMe()`), which the folder's item count
  does not include (spec says "Shared 5", the directory has 5 files, the listing shows 8);
- the two reference search hits `Design/overview.pdf` and `Design/beach.png` (`indexedOnly`), which are
  found by search but not listed in the folder, so "Design 8 items" holds.

## Serving the files

The `filex-demo-assets` plugin in `vite.config.ts` serves the whole directory under `/app/demo-assets/`
in dev (content types by extension, `application/octet-stream` fallback, range requests for `<video>`,
`Content-Disposition: attachment` when `?download=1` is present, 404 for anything outside the directory)
and, on `build`, copies the whole directory (~31 MB) into `dist/demo-assets/`.

`Thumbnail.vue` renders `assetUrl` as `<img loading="lazy">` for images and as a muted `<video
preload="metadata">` seeked to one second for video, with the placeholder artwork as fallback when the
request fails. The details panel shows a larger preview for image nodes. `PreviewModal.vue` opens the file
itself (image, video, PDF in an iframe, text-like files fetched into a `<pre>`, CSV as a table; everything
else gets a download card), and Download links point at `assetUrl?download=1`.
