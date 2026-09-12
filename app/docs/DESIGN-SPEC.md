# filex user UI — design spec (from reference screenshots)

Source of truth for the new end-user SPA in `app/`. Four reference screenshots
exist (the orchestrator sees them; agents work from this document). Numbers are
measured at the reference size **1672 × 941 CSS px** (treat this as the baseline
viewport for screenshot comparison). Colours are approximations of the refs and
may be tuned by overlay comparison.

> **Density pass.** The geometry below is the post-density layout, roughly the
> original drawn at 90 % — reached through the tokens in §1b and per-component
> sizing, never through a global `zoom` or `transform`. Where a figure reads
> like the reference screenshots' own (72px topbar, 280px sidebar, 236px cards),
> that is the *pre-density* number and this document has been updated past it.
> The look does not change: same palette, same soft borders, same rounded
> controls, same dominant previews — only the spacing and the type get tighter.
>
> §1-§4 carry the new figures. §5-§7 keep their original geometry — the density
> pass did not relayout the modals, the assistant panel or the trays — but every
> type size they name has come down one step on §1's scale (their "15" is 13,
> "14" is 11.5, "13" is 11, and so on); read the scale, not their numbers.

## 1. Tokens

| Token | Value | Use |
|---|---|---|
| `--font` | Inter (self-hosted woff2), fallback system-ui | everything |
| `--c-bg` | `#ffffff` | content, topbar, panels |
| `--c-bg-sidebar` | `#f7f8fb` | sidebar |
| `--c-bg-muted` | `#f3f4f6` | search input, tab strip, assistant bubble |
| `--c-border` | `#e5e7eb` | 1px borders |
| `--c-border-soft` | `#eef0f4` | table row separators |
| `--c-text` | `#1f2937` | primary text |
| `--c-text-2` | `#4b5563` | table headers, labels |
| `--c-text-3` | `#6b7280` | meta, placeholders, section captions |
| `--c-primary` | `#2f6ceb` | buttons, active icons, links, checkbox fill |
| `--c-primary-hover` | `#2559c9` | |
| `--c-primary-soft` | `#e6ecfa` | active nav, selected row, avatar bg, chips |
| `--c-primary-ring` | `#8fb0f7` | selected card border |
| `--c-primary-tint` | `#eef3ff` | selected card bg |
| `--c-folder` | `#f4b400` | folder icon fill |
| `--c-success` | `#16a34a` | "Online" dot |
| `--c-highlight` | `#fde68a` | search snippet highlight |
| radius | 8 / 10 / 12 / 14 / 16 / pill | icon-tiles / inputs, buttons / cards / search box, bubbles / modal / chips |
| shadow-modal | `0 20px 60px rgba(17,24,39,.18)` | |
| shadow-menu | `0 8px 24px rgba(17,24,39,.12)` | dropdowns |

Both themes live in one place: every token is a `light-dark(<light>, <dark>)`
pair in `tokens.css`, and `color-scheme` picks the side. The root declares
`color-scheme: light dark` (follow the OS); the settings modal stamps
`data-theme="light"` / `"dark"` on `<html>` to override it, which also gives
native controls and scrollbars the matching look. Dark values: bg `#15171c`,
sidebar `#1a1d23`, muted `#23272f`, border `#2e333c` / soft `#262a32` / hover
`#3d444f`, text `#e6e8ec` / `#b4bac4` / `#888f9b`, primary `#5b8cff` (hover
`#7ba3ff`, soft `#22304d`, ring `#4a76d8`, tint `#1c2740`), success `#34d399`,
danger `#f87171`, highlight `#6b5a17`, hover card/row `#1f232a`, overlay
`rgba(0,0,0,.62)`. The folder yellow and the figma gradient stay as they are.

Type scale (px / weight): 18/600 logo and page titles, 17/600 modal titles,
14/600 details-panel title, 13/600 section titles ("Folders", "24 matching
items"), 13/500 nav items and item names, 12/600 side-panel headings and tabs,
13/400 body, breadcrumbs, search box and table cells, 12.5/500 card names,
12/400 filter chips, table rows and menu rows, 11.5/400 meta, 11/400 small meta
and card meta, 10/600 uppercase captions (letter-spacing .06em). Nothing normal
and secondary goes below 11. Body line-height 1.5, single-line rows 1.

Icons: lucide, 18px stroke 1.75 in nav and topbar, 16px in chips, cards, table
rows and toolbar buttons. The glyph is not the hit area — §1b.

## 1b. Density tokens

The app is sized from a short ladder rather than from per-component pixel
counts, so "how big is a control here" has one answer per size. All three live
in `tokens.css` and reach components as Tailwind's `h-control-*` / `w-control-*`.

| Token | Value | Use |
|---|---|---|
| `--control-sm` | 28px | filter chips, the folder-filter box, card and row ⋮ buttons, menu rows |
| `--control-md` | 34px | search box, sidebar rows, breadcrumb/filter rows, view toggle, default `IconButton`, `Button size="md"` |
| `--control-lg` | 40px | the New button, modal footer buttons, the outlined Info / path toggles |
| `--space-1..4` | 4 / 8 / 12 / 16px | the spacing ladder — Tailwind's `1 / 2 / 3 / 4`; anything off it needs a visual reason |
| `--radius-sm/md/lg` | 6 / 8 / 10px | `rounded-sm` / `rounded` / `rounded-md`; cards `rounded-lg` 10, search box `rounded-md` 10, modal `rounded-2xl` 14 |

**A smaller glyph is not a smaller target.** `IconButton`'s `size` is the hit
area and stays at 28 or more while the glyph inside it is 16-18.

## 2. Shell (every page)

```
┌ sidebar 192 ┬ topbar h48 ───────────────────────────────┬ right panel (optional) ┐
│             ├ content (see §3/§4)                        │ 256 details / 432 AI  │
```

Content padding: the column is inset 16px from the sidebar and 12px from the
right, 12px from the topbar, 24px at the foot. The sidebar and the inspector
gave up 88px and 108px respectively, and the card grid (§3) takes all of it.

**Sidebar** (w 192, rail 60, bg `--c-bg-sidebar`, border-right 1px):
- Row 1 (h 48, the topbar's height so the two rules line up): burger icon 18px;
  logo mark 28×28 radius 8 primary with white folder glyph; word "filex" 18/600.
  Mark and word are one button and reload the app.
- **Branding** (`GET /api/branding`, public and pre-session, read once at
  start-up): `name` replaces "filex" here and in the tab title, `logo_url`
  replaces the mark (`object-contain`, so an operator's own aspect ratio is not
  stretched into the 32×32 box), and `accent` repaints the five `--c-primary`
  tokens. The accent mirrors the server's rule for its public pages — the
  colour itself, hover at ×0.85, a 14% wash — and adds ring at 45% and tint at
  7%, which the server has no counterpart for. Four of the five are
  translucent, which is what lets one hex serve both themes; only hover is
  opaque and so goes through `light-dark()`. `footer_text` and
  `hide_powered_by` are NOT read: they dress the public share and drop pages,
  and this app has no footer. An unbranded install answers with empty strings
  and a failed request is swallowed — branding is decoration and must never
  keep the app from opening.
- **New** button: full width inside a 12px gutter, h --control-lg (40),
  radius 10, primary bg, white `Plus` 18px + "New" 13/600, the two centred in
  the button as the ref draws them (not aligned to the nav columns below). A
  32px `ChevronDown` cell closes the right end behind a 1×16 white/25 rule,
  centred rather than full height; it is an affordance, not a second action —
  both halves open the same dropdown (Folder, File — disabled until a backend,
  divider, Upload files, Upload folder). It stays a full-width primary CTA: the
  density pass takes its height, not its rank.
- Nav list: item h --control-md (34), gap 1, padding-inline 12, icon 18 with an
  8px gap to the label 13/500. Active item: bg `--c-primary-soft`, radius 10,
  spanning the row between the list's own 6px gutters.
  Items: Home, My files, Shared with me, Recent, Starred, Trash.
- Caption "STORAGES" (10/600 uppercase, `--c-text-3`, 12px inset); storage
  items same geometry as nav (icon `HardDrive`), active state identical. Active
  is the drive the LISTING is in, not "some files route" — the condition was the
  route name alone, and a second drive made every row light up at once.
- **The home drive is not a storage row.** `main` is the system drive that
  holds the users' own files, the way `/home` does; "My files" opens it, and
  `/files` with no drive in the address means it whatever the server's order.
  The STORAGES section lists the drives mounted beside it, and is left out
  (caption, rule and all; the Home page's cards likewise) when there are none.
  Where `main` is still named as a drive — the quota block, the destination
  select of Move/Copy — it reads "main — home folder".
- **Drive in the address.** The files route is `/files/<drive>/<path…>`: the
  drive is the first segment, so the URL says what a node id says
  (`/files/main/Docs` is `main://Docs`). It has to be there — without it a
  reload or a pasted link can only guess, and guessing opens somebody else's
  drive under the address you typed. `/files` with no drive, and the flat
  listings, mean the first drive. A drive that does not resolve gets the
  not-found state and leaves the sidebar saying where you still are; no drives
  at all is the server failing, not the address, and gets the `load` state with
  its retry — which re-runs start-up, not just the listing.
- Caption "CONNECTIONS"; items "How to connect" (`Cable`, `/connect`)
  and "API keys" (`KeyRound`, `/api-keys`), same geometry and active state as
  the nav above. Both pages mount shared `@brftech/filex-core` components —
  `ConnectionsPanel` and `TokensPanel` — which read the live deployment, so
  they are links only when a server is answering (`Capabilities.connections`)
  and stay inert ("Coming soon") against the mock.
- Quota block pinned bottom, 12px inset, 16 from the foot: storage name 12/600,
  "12.4 GB of 100 GB used" 11 `--c-text-3`, progress bar h 6 radius pill bg
  `#e5e7eb`, fill primary, full width of the block.

**Topbar** (h 48, white, border-bottom 1px):
- Search box: 16px from the sidebar, h --control-md (34), radius 10, bg
  `--c-bg-muted`, `Search` icon 16 at left padding 12, placeholder "Search in
  {storage}…" 13 `--c-text-3`. It grows with the bar up to 760 (560 while the
  assistant panel is open) — capped, because a field the width of the window
  reads as a page rather than a control. Right end: `SlidersHorizontal` 16 in a
  28 hit area (opens the Advanced search modal; product addition, not in the
  ref), then two kbd chips "⌘" "K" 20×20 radius 6 border 1px bg white 10px,
  gap 4. Enter in the box runs a quick search (`/search?q=…`, all filters
  default); the modal is the separate advanced search.
- Right cluster (glyphs 18px `--c-text-2`, hit area 34×34, gap 2): `Sparkles`
  (opens the AI assistant; hidden while the panel is open so the bar keeps the
  reference width), the theme button, `Settings`, `HelpCircle`, then avatar 36
  circle bg `--c-primary-soft` letter 15/600 primary, then `ChevronDown` 16.
  Help is inert for now (`aria-disabled`, tooltip "Coming soon", no dimming).
  The ref's `LayoutGrid` (view/apps) is dropped: it led nowhere.
- Theme button (product addition, not in the ref): one control cycling
  light → system → dark,
  its icon the state it IS — `Sun` / `Monitor` / `Moon`. A menu would be three
  clicks for what is usually the next one along. Writes straight through, so it
  applies on click; the settings modal's Appearance row is the same setting
  behind a draft, and it covers this button while open.
- Account menu (avatar): "User settings" opens the modal, "Admin settings"
  opens `/admin/settings` in a new tab and is shown to admins only — the
  console's own guard turns everybody else away — then "Sign out", inert.

## 3. Page: My files — grid + Details (ref 1)

- **Breadcrumb row**, h --control-md (34): `Home` icon 16 in a 28 hit area
  (goes to the storage root), `ChevronRight` 14 gray, "demo" 13/600,
  `ChevronRight` 14 (dropdown of sibling folders).
- Right side of that row: the path-edit button, then the segmented view toggle
  h --control-md radius 10 border 1px: two 40px cells, `List` and `LayoutGrid`
  icons 16; active cell bg `--c-primary-soft` icon primary. Then `Info` button
  40 wide × --control-md radius 10 border 1px (toggles details panel; filled
  tint when open).
- **Filter chips** row min-h --control-md, chips themselves h --control-sm (28),
  radius 8, border 1px, bg white, text 12 + `ChevronDown` 14, padding-inline 10,
  gap 8: Type (w 76), People (86), Modified (96), Size (74). The "Filter in this
  folder…" box beside them is the same 28 high, w 210, radius 8. Right-aligned:
  "Name" 12 + `ArrowUp` 14 (sort), then `MoreVertical` 16.
- The row WRAPS. The four menus are fixed, but the chips set from the details
  panel (§12) are as many as the node has tags, and on one unbreakable line they
  pushed the name box and the sort control off the page. It is 38 high until
  there is a second line to draw, so nothing moves in the common case.
- **The chips live in the URL**, the way `/search?q=…` carries the advanced
  search: `?type=images&size=medium&owner=7&tag=design&tag=q3&date=modified&at=<ISO>&span=day`.
  Read before the listing opens, so the first request is already the filtered
  one, and written back with `replace` — a filter is an adjustment to the view,
  not a place, and a history entry per chip would make Back a slow undo of
  one's own clicks. Arriving at the folder pushed an entry, so Back still takes
  the whole filter off; moving to another folder drops it, because the
  narrowing is part of that folder's address rather than a mode carried around.
  The name box stays out: it is cleared on every navigation by design, and the
  address would be a second answer to when it survives.
- **One vocabulary with the advanced search.** `type`, `modified`, `size`,
  `owner`, `tags` and the window's `date`/`at`/`span` mean the same thing on
  `/search` as they do on a listing, and the window itself is one module
  (`data/dateWindow.ts`). Two spellings for one question is one of them going
  stale — which is what happened while the chips could ask for a date window and
  the search could not.
- Section title "Folders" 13/600, 8px above the grid. The grid is fluid —
  `repeat(auto-fill, minmax(176px, 1fr))`, gap 8 — so the width the sidebar and
  the inspector gave up turns into more cards per row at every viewport rather
  than into a wider gutter. Folder card h 56, radius 10, border 1px, bg white,
  padding-left 12. Content: `Folder` filled icon 28×24 `--c-folder`, name
  12.5/500, meta "12 items" 11 `--c-text-3` below (line gap 4), `MoreVertical`
  16 gray in a 28 hit area at the right. A folder card stays a CARD — icon,
  title, secondary line, overflow menu, hover and selected states — and is never
  flattened into a text row in grid mode. Shared folder shows a small people
  glyph inside the folder icon.
  Selected card: `--c-primary-ring` edge 2px wide, bg `--c-primary-tint`. The
  edge is a 1px border plus a 1px outline, not a 2px border: a border comes
  out of the content box, which shifts the thumbnail and rounds its top
  corners at the wrong radius. Outline changes no layout.
  Hover: bg `--c-hover-card`, border `#d1d5db`; cursor `pointer`.
- Section title "Files" 13/600; file card h 166 radius 10 border 1px overflow
  hidden, on the same fluid grid. **The thumbnail keeps its 108px**: the preview
  is the strongest part of this design and the density pass does not touch it —
  the footer below it is what gives ground, 66 → 58. Thumbnail: image cover /
  dark code block / document page mock / video with centered 44px play circle
  and duration badge "02:14" bottom-right 12px on rgba(0,0,0,.65) radius 6.
  Footer h 58 padding-left 8: type tile 24×24 radius 6 (colour by kind: md
  `#374151`, image `#2f6ceb`, ts `#2f6ceb`, pdf `#dc2626`, fig multicolour, csv
  `#16a34a`, mp4 `#7c3aed`) with white glyph, name 12.5/500, meta "2.4 KB •
  Jul 10, 2026" 11 `--c-text-3`, `MoreVertical` 16 in a 28 hit area at right.
- Section spacing: 20px above a section title, 8px below it. Sections stay
  further apart than the elements inside them, but not by a blank screenful.
- Empty state: centered icon 40 + title 13/500 + hint 11.5 gray.

**Details panel** (w 256 flush right, border-left 1px, padding 12). A
properties inspector, not a dashboard: section title, content, divider, section
title — nothing wrapped in its own rounded card, hierarchy carried by the
dividers and the spacing alone. 256 is the default: the same 4px handle as the
assistant's (§6) drags it between 230 and 720, remembered with the other layout
choices. **Not in the reference.**
- Header: `Folder` icon 34×28 amber (files: their 28px type tile), name 14/600,
  meta "Folder • 8 items" 11 `--c-text-3`; `X` 16 in a 28 hit area at top-right.
- Tabs: "Details" | "Activity", each 50%, h 38, 12/500, active primary with
  2px primary underline, strip bottom border 1px.
- "General" 12/600; rows (label `--c-text-3` 11.5 in a 76px column, value
  `--c-text` 11.5, row h 25 — a fifth off the old 31, so the five facts read as
  one block rather than five bands): Type, Location, Size ("—" for folders),
  Modified "Jul 8, 2026, 11:24 AM", Created, Owner "You".
- **Who the Owner row and the Owner column name.** On a drive of one's own:
  "You" for the caller's rows, the person's name for anybody else's. On a
  SHARED drive — one the person reaches through grants rather than through their
  role, which `GET /api/files/storages` reports as `shared` — the name is the
  DRIVE's. Everybody in a team drive can see everybody's files, so which
  colleague happened to upload one is noise; what the reader needs to know is
  that the drive is not theirs. filex has no group entity and none was invented
  for this: the drive IS the group. The rule lives in
  `features/files/owner.ts` so the panel and the listing cannot disagree.
- **Every property row is a way into the filter.** Type, Size, Modified,
  Created and Owner are buttons (underline on hover) that narrow the listing to
  the rows like this one — the type group and the size band the chips already
  offer, the owner, and for the two dates a WINDOW of a day either side of what
  the row shows rather than that calendar day. They MERGE into whatever is
  already filtered, so two clicks are two conditions; a date window and the
  Modified chip's preset replace each other, since both are windows over the
  same column. Location is the exception: it is an address, and opens the
  folder. A property nothing can be asked about (a folder's size, a type in no
  group) stays plain text. Home has no listing, so a filter set from there is
  applied to the folder the node lives in and the page follows it.
- Divider 1px, 12px of air each side.
- "Tags" 12/600 (only where the server has tags); each tag a pill h 28
  `--c-primary-soft` with a `Tag` 12 icon, and clicking it adds that tag to the
  filter. "No tags" 11.5 gray when there are none, and a read that failed says
  so rather than claiming there are none. Tags are read per node: no listing row
  carries them, which is also why a tag filter is always the server's to apply.
- The two filters set from here — the tags and the date window — appear in the
  filter row above the listing (§3) as primary-soft chips, capped at 200px.
  They carry a VALUE, not a sentence: "Sep 11, 2026 ±1d" behind a
  `CalendarClock` (written) or `CalendarPlus` (created) icon, "#tag" for a tag,
  truncating, with the full wording as the tooltip. Spelled out — "Created
  within a day of Sep 11, 2026" — one chip was wider than the three menus
  beside it and pushed the name box off the row.
- Each is two buttons in one chip frame, like the menus beside them: the body
  opens a dropdown that EDITS the value, the `X` 14 removes the filter. A date
  window's menu is which date it reads (Modified / Created) and how wide it is
  (±1 hour / ±1 day / ±1 week, divider between the two questions); a tag's is
  every tag on the drive (`GET /manager/tags/all`), the current one checked and
  the ones other chips already hold inert, so picking one SWAPS this chip. A
  chip whose only gesture removed it was a filter nobody could adjust without
  going back to the panel.
- Divider. "People with access" 12/600; row: avatar 24 + name 11.5 + role 11 gray.
- Divider. "Shared link" 12/600; row: `Link` 14 in a 24 circle `--c-bg-muted`,
  "Not shared" 11.5 gray; right button "Create link" h --control-md radius 10
  border 1px 13/500. When shared: URL text truncated + `Copy` icon button +
  "Remove".
- Activity tab: vertical list of events (avatar, "You renamed …", time),
  version entries and comments, newest first.

## 4. Page: My files — list view (ref 2)

- Table header h 30: checkbox 20×20 radius 5 border 1.5px; "Name ↑" 12
  `--c-text-2` (clickable sort, icon 16), then "Owner", "Last modified", "File
  size". Header border-bottom 1px `--c-border`.
- Row h 34 (28 in the compact-list setting), separator 1px `--c-border-soft`:
  checkbox, icon 24 (folder amber; file: 24×24 thumb radius 6 or type tile),
  name 12.5/500, "12 items" 12 `--c-text-3` (folders only), owner 12, date 12
  "Jul 8, 2026, 11:24 AM", size 12 ("—" for folders), `MoreVertical` 16 in a 28
  hit area. 34 is a comfortable row, not a hairline — §14's "thin hard-to-click
  rows" is exactly what this must not become.
- Selected: bg `--c-primary-soft`, checkbox filled primary with white check.
  Hover: bg `--c-hover-row`; cursor `pointer`. Column widths: name flex,
  owner 132, modified 190, size 110, checkbox 48, menu 48 — the fixed columns
  shrank with the text they hold and the flexible name column takes the
  difference.
- Right of filter chips: sort control pill h --control-md border 1px: "Name" 12
  + `ArrowUp` 14 + divider + `ChevronDown` 14.
- Keyboard: ↑↓ move focus, Space toggles, Enter opens, Delete → trash, F2 rename,
  Ctrl/Cmd+A select all, Esc clears, Ctrl/Cmd+X/C/V cut / copy / paste,
  Ctrl/Cmd+Z takes back the last action and Ctrl/Cmd+Shift+Z puts it back,
  bare `R` refreshes the listing.
  Refresh is a bare letter because Ctrl+R and F5 both belong to the browser and
  stay with it; the letter is free while the listing has no type-ahead.

## 5. Advanced search modal (ref 3)

Overlay rgba(17,24,39,.45). Card x 476..1198 (w 722), top 62, radius 16, bg
white, shadow-modal, padding 26 26 22.
- Header: 36 circle `--c-primary-soft` with `Search` 18 primary; "Advanced
  search" 20/600; subtitle "Find files by name, content, path, or tags." 14
  `--c-text-3`; `X` 22 top-right.
- Query input y 148 h 44 radius 10 border 1px, `Search` 18 gray, placeholder
  "Search files, text inside files, folders, or tags" 15.
- Scope tabs y 210 h 42: strip bg `--c-bg-muted` radius 10 padding 3, four
  equal cells with icon 18 + text 15: All (`FileText`), Content (`FileText`),
  Paths (`Folder`), Tags (`Tag`). Active cell bg `--c-primary-soft` text primary,
  radius 8. Cells separated by 1px `--c-border` hairlines.
- Two columns: left x 502..820, right x 855..1172, row gap 22 (implemented as
  18: with 22 the divider below lands at y 690, or at 678 only with the last
  row's chips / checkbox 6px above it).
  - Left: "Search in" 15/600 + `HelpCircle` 14 gray; radios 20 (Current folder:
    demo / All storages / Shared files), 15, gap 8. "Modified" → select h 40
    radius 10 border, `Calendar` 18, "Any time", `ChevronDown` right; under it
    "Or around a date" 11.5 gray with a date box (w 150) and a dense width
    select (±1 hour / ±1 day / ±1 week), and — once a date is set — a second
    dense select saying which date the window reads (Modified / Created).
    It is the window the listing chips and the details panel carry (§3, §12),
    down to the URL parameters, and the only way to ask about the CREATION
    date at all. The preset and the window replace each other: both are windows
    over one column, and set together nothing could be inside both. A day
    picked here centres the window on its NOON, so "±1 day" covers that day
    with a night either side rather than starting at midnight.
    "File type" → select with `File` icon "Any file type". "Tags" → input
    "Add or select tags…" h 40, below it chips (pill h 28 bg `--c-primary-soft`
    text primary 14 + `X` 14): "design", "project alpha".
  - Right: "Owner" → select `User` "Any owner". "Size range" → row: select "Any
    size" w 94, input "Min" w 70, "–", input "Max" w 70, select "MB" w 62, all
    h 40, gap 8. "Path" + help → a two-cell segmented control h 32 above the
    field ("Only here" / "Skip this"), then input "/demo/design/" h 40, hint
    "Example: /demo/design/" 13 gray. The hint follows the mode, because a path
    box that means the opposite depending on a control above it has to say which
    it means: "Search only inside this folder" / "Leave this folder out". See
    §7d. "Content search options" 15/600 with `FileText`
    icon 18; one checkbox 20 radius 5: "Match whole phrase". The reference drew
    two more — "Case sensitive" and "Include document OCR" — and they are gone
    on purpose: the index lowercases every token it stores, so case cannot be
    asked of it without a second field and a full rebuild, and OCR'd text is
    part of a document's content already, so there is nothing for a switch to
    turn on. A box that changes no result is worse than no box.
- Divider y 678. "24 matching items" 17/600 left; "View all results →" 14
  primary right.
- Result rows h 36: icon 24 (folder amber / pdf red tile / image thumb),
  name 15/500 at +50, path 13 gray at +130 ("/demo/design"), snippet 13 gray
  centre with `<mark>` bg `--c-highlight`, right: date 13 gray, size 13.
  Folder row: "Updated Jul 1, 2026" + "8 items".
- Footer y 860 h 44: left "Reset" bordered radius 10 with `RotateCcw` 18
  (w 104); right "Cancel" bordered (w 94) and "Search" primary with `Search` 18
  (w 122), gap 16.
- Esc closes; Enter runs search; state mirrored into the URL query.

## 6. AI assistant panel (ref 4)

Panel w 432 right, white, border-left 1px, padding 20 22; opens independently
of the details panel (both may be visible, details sits between the listing
and the assistant); search box shrinks. Ref 4 shows it with details closed.
- Width is the person's: a 4px handle over the left border (`col-resize`,
  primary on hover/focus; a focusable `separator`, ←/→ step 16) drags it
  between 320 and 720, remembered with the other layout choices. 432 is the
  default and what every screenshot shows. **Not in the reference.**
- Whether the panel is open and which conversation it shows are remembered
  too: a reload or a new tab comes back to the same chat. A remembered chat
  that no longer exists is forgotten, and the panel opens empty. The details
  panel is not remembered (`?panel=` links stay honest).
- Header: `Sparkles` 26 primary at x 1290; "AI assistant" 20/600; "● Online"
  13 with 8px `--c-success` dot; then three 36px icon buttons at the right —
  `SquarePen` 20 (new chat), `MessagesSquare` 20 (chats, pressed while the list
  is open), `X` 22 (close). **The reference draws only the `X`**: it was made
  before the assistant kept a history, and a history nobody can reach is not a
  history. The two buttons are the whole of the deviation; nothing else in the
  panel moved.
- Chat list (behind `MessagesSquare`, replaces the body): search input h 40,
  then a capacity line 13 gray naming the cap and the eviction rule, then rows —
  title 15 over "N messages · date" 13 gray, with rename and delete icon buttons
  32 appearing on hover AND on keyboard focus. A conversation is **named by the
  server** as its first answer ends (a `title` frame on the same stream), so a
  row stops reading "Untitled chat" without the list being refetched; a name the
  person typed is never replaced. Filtering is client-side: the
  history is capped at 100 per account, so the list is already in the browser.
- The mode chips (filename / content / tags) are drawn as the reference has
  them and ARE sent with the question, as `mode`. The server turns the chip
  into one sentence of guidance appended to that turn's question — search by
  names / look inside contents / narrow by tags — and nothing else: it is not
  stored with the question and not replayed, so the chip belongs to the turn it
  was set on, exactly as it looks on screen. They were inert until the
  assistant had search tools; sending a field the server ignored would only
  have looked like it worked. What is on screen travels the same way, as
  `context`: the page, the open folder, the selected rows' addresses and, on
  the search page, the query, the non-default settings, the count and the
  first hits — so "these files" and "this folder" are answerable. Nothing is
  drawn for it; it is the question's context, not a control.
- Permission card (below the answer that raised it, full width, border 1px
  radius 12 padding 16): "May I open this file?" 14/500, the full address 14
  gray (breaks anywhere — an address is longer than the panel), the assistant's
  own stated reason 13 gray, then two 36px pill buttons — primary "Allow this
  file", outlined "Not this one". Once answered, both are replaced by a 13
  line: green "You allowed this file", gray "You did not allow this file" or
  "No answer came, so the assistant went on without it". **Not in the
  reference**, which was drawn before the assistant could open anything. One
  card per file, always: there is no button anywhere in this flow that approves
  more than the one file it names.
- **The card is an interrupt, not a message.** The turn stands still at it on
  the server; the buttons stay enabled while the answer streams (they are what
  it is waiting for), the click goes to the approvals endpoint and the same
  turn goes on — nothing is typed into the chat, the activity line shows no
  "Thinking…" while the card is open, and the silence watchdog is held until
  it is answered. The first version sent "You may read `…`" as a message,
  which cost a model round and read as the person talking to the assistant
  about permissions.
- Mode chips carry a tooltip saying what each does to the search ("Search file
  and folder names only", …): the chip binds the search tool on the server,
  and a control whose effect is invisible reads as decoration.
- Plan card (ref: the "Move 9 .webp files" mockup): radius 16, `--c-bg-muted`,
  border 1px `--c-border-soft`, padding 16. Header: `Sparkles` 22 primary, the
  assistant's summary 15/500, then two 28px icon buttons — `Copy` 16 (the plan
  as text: summary, then one `address — action` line per item) and `Maximize2`
  16 (below). Then EVERY item as a 40px-picture row (the image itself, or the
  type tile; a `mkdir` line gets the folder glyph), hairline `--c-border-soft`
  between rows: the name 14/500 on one line, and under it 13 gray everything
  that makes the line readable alone — size (and date where it matters), the
  folder, what will happen — joined with " · ". The reference drops the folder
  and the action; both stay, because two files may share a name and a plan is
  approved by reading it. At the right a 20px `CircleCheck`, gray while the
  plan is pending, green once that item is done, `CircleAlert` red with the
  reason appended to the gray line for a skip or a failure. Two 40px pill
  buttons — primary "Approve and run" with a filled `Play` 16, outlined "Don't
  do this"; after the decision they are replaced by the refusal line, or by
  "Done" under the list (the per-item outcome is on the rows).
  **The whole list is always drawn, never a count.** A card reading "12 changes"
  with an Approve button is a button with nothing behind it — the plan is
  approved by reading it. The list is capped at 400px and scrolls inside the
  card, and a `Maximize2` 28px icon button at the card's top right opens the
  same plan in a 720px modal (list capped at 60vh, the same Approve / Don't
  buttons in its footer) — a fifty-line move, or a thousand-line tagging, is
  read there rather than in a 432px column.
  ⚠ The item wording and the numbers come from the SERVER as a code plus raw
  values (`tag`, `purge`, a byte count, an ISO date), and the panel renders them
  through i18n and its own formatters. The first version had the server compose
  the sentence, which put "44 bytes, deleted 2026-09-08T13:47:58Z" into a
  Russian conversation.
- Activity line (13 gray with a spinning `Loader2` 14, under the last message
  while a tool runs): "Looking in main://Docs", "Reading …". Also not in the
  reference. It exists because a turn that lists a folder, searches and then
  answers is twenty silent seconds otherwise, which reads as a stall. The same
  line says "Thinking…" from the moment the question is sent until the first
  word or tool arrives — the model's first token can be many seconds away, and
  a panel showing nothing for them reads as a request that never left.
- **A turn that says nothing for a minute is dropped.** No word, no tool, no
  error in 60 s is a hung connection, not a slow answer: the server says what
  it is doing when it is doing something. The app closes the connection and
  the answer gets the line "No answer came for a minute, so the request was
  dropped. Try again." — not "Stopped", which is what the person does.
- **Failure lines say who has to act.** Under a failed answer, 14 `--c-danger`:
  "Something went wrong. Please try again." for the ordinary case; "The
  assistant's provider account is out of credit. Ask an administrator to top it
  up." when the turn's error frame carries `code: quota`; "The assistant is no
  longer available: it was switched off, or its provider stopped answering for
  it." on `code: unavailable` or a 503 from the turn route. Trying again
  changes neither of the last two, so they are not worded as if it would.
- Intro 15 `--c-text-3` line-height 1.5: "Find files by content, filename, or
  tags. I can also summarize files, answer questions, and help you organize
  your work." It is the empty log's placeholder, drawn inside the log area and
  gone with the first message — not a heading the conversation scrolls under.
- User message: bubble bg `--c-primary-soft` radius 14 padding 12 16, text 15,
  timestamp 12 gray below inside bubble; avatar 36 "D" at right; bubble max-w
  270, right-aligned.
- Assistant: 32 circle border 1px with `Sparkles` 16 primary at left; bubble bg
  `--c-bg-muted` radius 14 padding 12 16 text 15 line-height 1.45; timestamp 12.
  The answer is **Markdown**: headings as 15/600 lines, bulleted and numbered
  lists indented 20, `code` and fenced blocks in the monospace `font-code`
  utility on `--c-bg`, bold and italic. Blocks are 8 apart; nothing else about
  the bubble changes.
  ⚠ It is parsed into a token tree and drawn as elements — never `v-html`. A
  model's words are shaped by the files it just read, so markup it emits is
  shown as the characters it wrote, and a link is a link only if it is http(s).
  Underscores are not italics: file names are full of them.
- A `storage://path` address in an answer is a **link** when it names the drive
  the app is showing: a file opens the preview, a folder opens the folder. An
  address on another drive stays monospace text, because there is nowhere to
  send the reader until multi-storage navigation lands. An address with spaces
  in it survives only if the model wrapped it in backticks — the system prompt
  asks it to, and a bare one ends at the first space, the same way every
  Markdown renderer treats it.
- Result list — all hits of one answer in ONE card (full width, border 1px
  radius 10), never a stack of separate cards, rows split by a
  `--c-border-soft` rule. Row (padding 8/12): icon 24 (pdf tile red radius 8 /
  fig / md), name 12/500, path 11 gray, "Matched content: "…"" 11 gray (wraps),
  `MoreVertical` 16 top-right.
  Drawn from the `hits` frame the server sends whenever the assistant ran a
  search — the same rows the model reads as JSON — and stored with the answer,
  so reopening the conversation redraws them. The snippet's matched words
  arrive wrapped in « » and are turned into highlight ranges, never shown as
  those characters.
- Report card (full width, border 1px `--c-border-soft` radius 16 padding 16,
  muted bg, same box as a plan card): `FileText` 22 primary, title 15/500,
  "N files" 13 gray, `Maximize2` 28 top-right opens the full list in a modal
  (720 wide, rows name 14/500 + address 13 gray + size + date). Optional
  Markdown text below the title, then two outline buttons with `Download` 16:
  "Download as text", "Download as CSV" (the CSV one only when there are rows).
  Drawn from the `report` frame `write_report` sends; the rows never appear in
  the panel itself — that is the point of the card, an answer names at most 20
  files. The files are built in the browser from the rows; nothing is fetched.
- Follow-up line 15 + timestamp 12.
- Mode chips h 38 pill: "Filename" active primary bg white text with `File`
  16; "Content" (`Search`), "Tags" (`Tag`) bordered; gap 10.
- No suggestion chips under the mode chips. The reference draws two ("Find
  contracts from July", "Search by tag: design"); they were canned prompts
  that fit no real drive, and were dropped.
- Input row bottom: textarea h 40 radius 12 border 2px primary (focused) /
  1px `--c-border` (idle), placeholder "Ask to find files…" 13; send button
  40×40 radius 12 primary with `Send` 18 white; gap 10. Hint below 13 gray:
  "Try searching by topic, filename, or ask a question…".
- Enter sends, Shift+Enter newline; disabled when offline (dot grey, "Offline").

## 7. Secondary surfaces (no ref — same language)

- **Item ⋮ / context menu**: white, radius 12, shadow-menu, padding 6, items h 38
  15 with 18px icon: Open, Preview, Download, Share, Rename, Move to, Cut,
  Copy, Copy to, Add to starred, Tags, Version history, Manage access, divider,
  Move to trash (red `#dc2626`). Cut and Copy load the clipboard for a later
  paste; Move to and Copy to name the destination in a dialog and act at once.
- **Modals** (Rename, New folder, Delete, Share): radius 16, w 480, padding 26,
  title 20/600, inputs h 44, footer buttons h 44 radius 10.
- **Destination picker** — one dialog behind both Move to and Copy to: storage
  select, folder filter, and the folder tree of the chosen storage, max height
  320. The tree is loaded a LEVEL at a time: the root is open, a chevron opens a
  folder and fetches what is in it. Loading the whole drive up front is one
  request per folder, and almost none of it is ever looked at — a person opens
  two or three and picks one. The filter box therefore asks the SERVER (folders
  only), because a filter over the levels somebody happened to open is not a
  filter; its hits are shown flat, each with the folder path it lives in, since
  the indentation that used to say so is gone. A node's own subtree is never a destination. The folder the nodes already
  sit in is disabled for a move (nothing to do) and offered for a copy, which
  duplicates them in place as `<base>-copy`. Copying across storages spans two
  adapters, which the server refuses: the other storages stay in the select,
  greyed, under the line "Copying between storages is not supported yet."
- **Pages** Home / Shared with me / Recent / Starred / Trash: same content
  frame; header row with title 22/600; Recent groups by day ("Today",
  "Yesterday", "Jul 5"); Shared with me adds "Shared by" column; Trash adds
  "Deleted" column and a top banner "Items in trash are deleted forever after
  30 days" with "Empty trash" button.
- **Selection bar** (appears above table when ≥1 selected): h 48, "3 selected",
  icon buttons Download, Share, Move, Star, Delete, `X` clear. Download saves a
  single file as itself and anything else — a folder, or several things — as one
  zip; where the server cannot zip (`folderDownload` off, as in the demo's mock)
  it falls back to a click per file and skips folders.
- **Toasts** bottom-left, radius 12, shadow-menu.
- **Upload tray** bottom-right card w 360 with per-file progress. The bar is
  the byte count the server has accepted, not a timer: the repository uploads
  in 1 MiB chunks and reports each one, and a row is ticked done only once the
  storage has the file — filex answering "staged" is not yet an arrival. A
  transfer that fails marks its row with a red alert icon and the header says
  how many failed, because a bar frozen at 60% says nothing.
  A running row carries a 24px ✕ that **cancels that transfer alone** and drops
  what the server had staged for it; the row then reads "Cancelled" rather than
  vanishing, so whoever pressed it sees that it worked.
  ⚠ A transfer interrupted by a **reload** comes back: the session id is kept in
  `localStorage`, the server is asked at startup how far it got, and the row
  returns as "Stopped at N%" with **Resume** and **Discard**. Resume asks for
  the file again — the page has no bytes after a reload and a `File` cannot be
  stored — and refuses anything whose name or size is not the one the session
  was begun for. A session the server has forgotten is dropped silently rather
  than offered as a button that cannot work.
  Not in the reference, which was drawn before any of this existed.

## 7a. Filter chips

The four chips above every listing (Type, People, Modified, Size) are real
filters. Each opens a single-choice menu (`menuitemradio`, check column on the
left) whose values are the ones the advanced search form already uses, so the
two speak one vocabulary. A chosen value replaces the chip's label, drops its
fixed width and paints it `--c-primary-soft` with a primary border; "Any…"
clears it. Type and Size narrow the listing to files (a folder has neither),
Modified and People keep folders. The filter is session state: it follows the
user into the next folder and resets on reload. When it empties a listing, the
empty state offers "Clear filters".

The value lives in the store as a `ListingFilter` and is handed to the
repository, which applies it — the mock in `mock/search.ts`, the HTTP one as
query params on the listing endpoint (`ext`, `modified_after`, `size_min`,
`size_max`, `owner_id` — the advanced search's own words). That matters because
the flat listings are capped: a chip applied to the page instead of to the query
answers with the matches among the newest few hundred rows and looks exactly
like an empty result. The folder listing is the one exception, by size: a folder
with fewer than 1000 entries (the server's `total`) is held whole and the chips
sieve it in memory, so a chip costs no request there; from 1000 up every chip
change is a request, and the name box waits 250 ms for the typing to pause.

Beside the chips on My files sits a name box ("Filter in this folder…", pill
h 38, w 265, folder icon). It narrows the open folder by substring, case
insensitively, under the same rule as the chips — in memory for a small folder,
on the server for a large one — and is cleared on every navigation, because it
belongs to the folder it was typed in. It counts as a filter for the empty state and "Clear filters".

## 7b. Navigation, dragging and load states

- **Breadcrumbs**: the home button, then every folder above the open one, then
  the open folder as the `h1` (18/600, parents in `--c-text-2`). Above four
  crumbs the middle folds behind a "…" button that lists them. The chevron
  after the last crumb opens the open folder's subfolders, read fresh so the
  filter chips hide none; it says "No subfolders" when there are none.
- **Sidebar rail**: the hamburger collapses the sidebar to 76 px. Rows keep
  their height and active box, labels move to `sr-only` plus a tooltip, the
  section captions become a short rule, the New button becomes a round 44,
  and the quota block is dropped (it is nothing without its numbers). The
  choice is persisted next to the view mode.
- **Listing menu**: right-click on bare listing surface, or the grid's ⋮
  button — New folder, File upload, then Select all / Deselect all. The flat
  listings keep only the selection entries.
- **Drag and drop**: cards and rows are drag sources; dragging a selected node
  takes the whole selection. Folder cards, folder rows and every breadcrumb
  above the open folder are drop targets and highlight in primary. Files
  dragged from the OS drop on a folder to upload there, or anywhere else in
  the listing to upload into the open folder, which paints a dashed primary
  overlay across the content area.
- **Loading and failure**: while a listing loads with nothing to show, the page
  paints a skeleton in the shape of the cards or rows. A failed load — or a URL
  naming a folder that is gone — replaces the listing with a message and a
  "Try again" button; the shell around it stays usable.
- **Search results** carry a "Refine" button that reopens Advanced search on
  the query behind the chips, and a **drive picker** left of the count: a
  `HardDrive` select, w 176, "All drives" first and then every drive the account
  can see. It is a real narrowing rather than a sieve over the page — the drive
  travels to the server as its row id, so the count beside it is that drive's
  count and not "what survived of the first hundred". Picking a drive while the
  scope is "Current folder" widens the scope to that whole drive: the folder
  scope already names a folder on one drive, and two controls quietly overriding
  each other is the contradiction the Path box was taught not to have. A drive
  whose row id the server did not send (an older build) is offered disabled
  rather than silently searching everything.
- **Cut and paste** (Ctrl/Cmd+X, Ctrl/Cmd+V, and the two menus) is a move in
  two steps: cut rows stay in place at 50% opacity until they land. Paste
  targets the open folder, so it is disabled on the flat listings, and it
  silently skips a node that is already there or that would swallow its own
  parent. **Copy and paste** (Ctrl/Cmd+C) holds the same clipboard in the other
  mode: copied rows are not dimmed, pasting into their own folder duplicates
  them, and the server names the duplicate (`logo.svg` → `logo-copy.svg`, then
  `-copy-2`). Copy runs through filex's ops queue, the one verb with no
  synchronous form, so the repository submits the job and polls it to its end.
- **Undo / redo** (Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, plus the trash toast's
  button — one record, so the toast and the shortcut cannot both fire) take the
  last action back and put it again: trash, move, rename, paste, star, new
  folder. Depth is one step in each direction. A longer history would have to
  address nodes that later actions may have renamed or moved, and since an id is
  a path, a stale step would not fail loudly — it would act on whatever now
  answers to that path. Replaying a step is not itself a new action, and any
  real action drops the forward step. Deleting for good and emptying the trash
  disarm both.
- **Folder upload** takes the flat list the directory picker returns and
  rebuilds the tree from `webkitRelativePath`, reusing folders that already
  exist; the folders appear at once, the files as their transfers finish. The
  tree is built a LEVEL at a time — one level's folders are independent, so they
  are created together and the cost of a hundred-folder drop is the tree's depth
  rather than a hundred waits in a row — and a folder is created FIRST, with the
  name collision read as "it is already there". Asking in advance costs a whole
  listing of the parent to decide one boolean, and for a folder being uploaded
  the usual answer is "not there"; the listing still happens on a collision,
  which is when it earns its cost.

## 7c. Capabilities and tags

The app reads one feature snapshot at start-up (`GET /api/capabilities`, the
backend's `model.Capabilities`) and keeps it in `stores/capabilities.ts`.
Everything starts off, so no screen offers an action the server would reject;
the answer switches on what is really there. An action the server cannot serve
keeps its place in the menu, disabled, with "Not available on this server" —
a familiar menu that quietly loses entries is worse than one that explains
itself. The snapshot gates: Move to / Cut (`move`), Copy to (`copy`), Move to
trash (`delete`), New folder (`mkdir`), File upload (`upload`), Tags (`tags`),
Version history (`versions`), Manage access (`permissions`), Delete forever and
Empty trash (`delete_forever`), a folder or mixed-selection download
(`folder_download`), and the assistant's topbar trigger (`assistant`), which is
hidden rather than disabled because it opens a panel, not an action. `?caps=`
overrides the snapshot in dev builds. A second gate sits over the same entries:
the caller's ROLE permissions (`files.upload`, `.move`, `.delete`, `.purge`,
`.share`, `.grant`, `.tags`, `.star`, …), which disable an entry with "Your role
may not do this" — the installation is asked first, so a feature the server does
not have never reads as a role problem, and a server that reports no permissions
at all is taken to grant them all. Manage access grants to a PERSON or to a
GROUP, chosen with a People | Group toggle: a group row carries the group mark
and its member count instead of a face and an address, and an address with no
account behind it mints a public link, shown with a Copy button, instead of
adding a row.

**Tags** are edited in their own modal (item menu → Tags): a text field that
takes one tag per Enter, the current tags as removable chips, Cancel / Save,
and the whole list written in one call. A tag still in the box when Save is
pressed counts as typed. The details panel deliberately does not show tags —
the panel is a reference state (ref 1) and the folder it shows is tagged, so a
tags row there would move everything below it; revisit when the refs do.

## 7d. Path exclusions

A search that keeps answering with the same folder is the commonest way a good
query looks broken, and re-typing the query never fixes it — the folder is not
what the words said, it is what the drive happens to hold. So the way to get rid
of it is to point at it, not to describe it.

**From a result row.** Every result row carries a "Skip /demo/archive" button,
naming the folder that row sits in: a `FolderMinus` 18 in a 32 hit area, left of
the row's ⋮, revealed on hover or keyboard focus and absent on a row that sits
at a drive's root, where there is no folder to leave out. It is a button rather
than an entry in the ⋮ menu beside it because that menu is the FILES menu — it
acts on a node through the files store and knows nothing about a search — while
this acts on the query. Pressing it adds an exclusion chip above the list — the
§7a chip shape, with a leading `−` and the path as its label — and runs the
search again with that folder left out. The chip's `X` puts it back.
The chip survives a reworded query, because the folder the user rejected did not
change when the words did, and it clears with "Reset" along with every other
filter.

The count beside the divider stays what it always was: **what was found**. It
does not grow a "…and 6 skipped" half, and that is deliberate rather than
unfinished — the exclusion is applied inside the search engine, which never
returns the excluded documents at all, so a skipped count could only come from
running the whole query a second time without the exclusion. Paying for a second
search to print a number nobody acts on is the wrong trade; the chip already
says what was left out, by name, which is the part a person can do something
with.

**From the form.** The advanced search's Path box (§5) does the same thing ahead
of time, through a two-cell segmented control: **Only here** is the prefix filter
that box always was, **Skip this** is its negative. One path per mode, not a
list: a second exclusion is one more click from a result row, and a list in that
corner of the form would need a chip rack, an empty state and a scroll — three
things for a case the rows already answer.

⚠ **An exclusion names folders, not a place.** A chip reading `− /Design/Old`
was taken off one row, but what travels to the server is the folder names, and a
node's stored path starts below its drive — so on a multi-drive answer it hides
`Design/Old` wherever it occurs. That is the honest reading of what the operator
can express, and the fix when it is not what was meant is the drive picker
beside the count (§7b), which narrows the whole answer to one drive.

The box completes against the paths this browser has searched with before — see
§7e — and not against the folders that exist. An exclusion that names nothing is
not a narrower answer, it is an identical one, and with no skipped count to show
the difference, a typo'd folder looks exactly like a folder that was excluded;
offering back what was typed last time is what keeps the typo from happening
twice.

Since nothing counts what was removed, the chips ARE the record of it: they stay
visible above every result list they apply to, including an empty one, so a
result list emptied by an exclusion is read as an exclusion rather than as a
query that found nothing.

⚠ **An exclusion alone is not a search.** With the query box empty, the form
stops calling itself one: the divider reads "All files in demo, except
/demo/drafts", the rows come back in listing order rather than by relevance,
they carry no snippets, and the footer button says "Show" instead of "Search".
This is not a restriction dressed up — it is what the request actually is, and
the two shapes are answered by two different halves of the server (the index
ranks a query; the node table pages a listing). A form that called both "Search"
would be promising a ranking to a request that has nothing to rank.

The rules that keep it cheap are the same three everywhere: an exclusion under
two characters is not sent, it applies on submit rather than per keystroke, and
the path travels as a folder — a segment the index can look up — never as a
free substring, which costs a walk of the whole term dictionary. `docs/SEARCH.md`
carries the engine side of that.

## 7e. Search history

Both boxes of Advanced search complete against what this browser has searched
for before: the query box against previous query texts, the Path box against
previous paths. Plain `<datalist>` on the input rather than a menu of our own —
the browser already knows how to filter a list as you type, and it hands
keyboard and touch the behaviour they expect without a component to keep in step.

The obvious alternative was completing the Path box against the folders that
EXIST, and it is worse on every axis: a request per keystroke, answering with a
whole drive's tree, most of which the person asking has never opened. What people
retype is what they typed before.

Twenty of each, newest first, no duplicates, in `localStorage` under
`filex.searchHistory`. Repeating a search moves it up the list instead of adding
a second copy, and a difference of case or surrounding space is the same search —
the spelling kept is the most recent one, so a suggestion always looks like
something this person writes. A search is recorded when it RUNS, whatever it
found: the query that came back empty is exactly the one worth offering back when
it is tried again differently.

It is a convenience, not a document. It never leaves the device and nothing but
these two boxes reads it, so a browser that hands back nothing — a private
window, cleared site data, storage switched off — leaves both boxes working
exactly as they did before there was a history. Every read and write is wrapped
for that reason: a refused `localStorage` must not be able to break a search.

## 8. User settings modal (ref 5)

Opened by the topbar gear or by Account → User settings; hosted by the shell,
so it is reachable from every page. Panel 800 wide, 680 high (capped at the
viewport less 48), radius 16, padding 16 / 20 — a fixed height, so switching
tabs never moves the footer out from under the pointer. Header: 44 avatar,
title 20/600 "User settings", subtitle 14 in `--c-text-3`, close X top right.
Body below it: a vertical tab strip 150 wide (5 tabs, h 40, icon 18 + 15px
label, selected on `--c-primary-soft` in primary, arrows walk it), gap 32,
then the panel of the selected tab — the only scrolling area, with a 24
gutter and a 6px rail (`.scroll-thin`) rather than the platform's ~15. Footer
above the panel edge: 1px separator, Cancel (outline) and Save changes
(primary), both h 44.

One tab, one panel: only the selected panel is rendered, and it is flat — no
cards inside the panel. A panel opens with a 16/600 heading and a 13 caption
in `--c-text-3`; where it holds a second section (Storage & uploads, under
Preferences, which has no tab of its own) the two are told apart by a 1px rule
with 24 above and below it. Inside a section every setting is one row: the
label 15 (with an optional 13 caption under it) on the left, the control
right-aligned in a fixed 212 column; rows are 36 high, 52 when they carry a
caption, with a 4 gap.

Controls: Profile — 62 avatar, name + role pill + email, Change photo (Remove
appears only once there is a picture to remove), then Full name, Display name,
Email (read-only, muted) and Job title in a 2×2 grid. Preferences — Language
and Time zone selects, Theme as a 3-segment control (Light / System / Dark,
h 36), a "Use compact file list" switch with a caption. Storage & uploads —
default upload folder select, an auto-open-preview switch (44×24), upload
conflict select. Notifications — three switches with captions. Security —
three 40-high rows (icon 18, label 15, status 13 in `--c-text-3`, chevron):
Password, Two-factor authentication, Active sessions. What those rows say
comes from `GET /api/auth/methods`. The password row offers a change only
where the realm allows one and otherwise names that realm, because an OIDC
account's password lives at its identity provider; it opens in place into
three fields with its own button, since a password is not part of the draft
"Save changes" commits and "Cancel" throws away. Two-factor is filex's own
TOTP on a local realm (a green dot when it is on) and the provider's business
otherwise. Active sessions carries the count and opens in place into the list
(`GET /api/auth/sessions`): device and system read off the user agent, the
address and the sign-in date under it, "This device" on the session the app is
calling with and End session on every other one, which acts at once. AI
assistant — enable switch, default search mode select, a note that the
provider is set by the administrator. That note is literally true now: the
model, its endpoint and its key are an operator setting
(`PUT /api/admin/assistant/provider`), and an installation with no provider
configured reports no assistant at all, so the panel is never offered.

Editing works on a copy: Cancel drops it, Save changes commits everything at
once — and the copy has two destinations. Theme, the compact list, the upload
preferences and the time zone are THIS BROWSER's and stay in localStorage;
the profile fields (display name, full name, job title, picture), the language
and the three notification switches are the ACCOUNT's and go to the server, so
they follow the person to another machine. Of the Security rows two act
at once — the password change and ending a session — and neither waits for
"Save changes"; two-factor is read-only, because the second step belongs to
the auth provider. A session signed in before the server learned to record its
address reads "Unknown device", which is what is actually known about it.

## 9. Mock data (matches the refs)

The reference entries below are pinned by `REF_OVERRIDES` (dates, sizes, stars)
and always sort first; anything else in the assets directory is listed after
them with generated dates, so the root count follows the demo assets rather
than this document — the tests read it from the dataset.

Storage "demo", 12.4 GB of 100 GB. Folders: Code 12, Design 8, Documents 24,
Photos 56, example 3, Archive 17, Resources 9, Shared 5 (shared). Starred:
Photos, mountains.jpg, UI Design.fig (Design shows no star in the ref). Files:
README.md 2.4 KB Jul 10 2026 12:06 PM; mountains.jpg 12 MB Jul 9 09:26 AM
(grid shows 1.2 MB — use 12 MB); app.ts 4.8 KB Jul 8 03:14 PM; overview.pdf
2.1 MB Jul 7 11:22 AM; beach.png 3.4 MB Jul 6 02:17 PM; UI Design.fig 12.6 MB
Jul 5 10:08 AM; data.csv 568 KB Jul 5 09:41 AM; demo.mp4 24.8 MB Jul 3 04:55 PM
(duration 02:14). Folder dates: Code Jul 8 11:24 AM, Design Jul 1 09:12 AM,
Documents Jun 28 03:45 PM, Photos Jun 20 10:11 AM, example Jun 18 02:34 PM,
Archive Jun 14 01:20 PM, Resources Jun 10 04:18 PM, Shared Jun 5 11:03 AM.
Owner "You" everywhere; user "D" (demo). ⚠ The dataset these numbers describe
no longer exists in the repository: the mock repository, its generated demo
tree and the directory of real files behind it are all gone, and the app reads
a filex server instead. The figures above stay as the RECORD of what the
reference screenshots show — read them as the spec for layout and typography,
not as data any build will produce. The SVG/CSS placeholders
(mountain, beach, code block, doc page, spreadsheet, the figma design canvas —
layer panel wired to the frame it edits, component card, colour styles and an
empty slot — video gradient) stay as the fallback when the assets are not served. demo.mp4 shows
the real duration (00:30) once the browser reads it.

## 10. Responsive (refs: desktop / mobile portrait)

A fourth reference sheet draws the app on more than one device at once (the
orchestrator sees it, like the other refs). It adds no new screens — it says
what the screens in §2–§8 become when the window is not 1672 wide.

**Two layouts, not three.** There is no tablet layout: the middle band used to
draw a forced rail, overlay panels and a brand in the topbar, which is a third
geometry nobody designed and which read as neither of the two that were. A
window at 834 gets the desktop layout, and the phone layout starts where a
phone does.

**One edge, one source.** `src/design/breakpoints.ts` holds it, Tailwind's
`screens` are generated from it and `useBreakpoint()` reads the same number, so
an `md:` utility and a component asking "which layout is this?" can never
disagree:

| Layout | Width | What it is |
|---|---|---|
| `mobile` | `< 768` | The phone-portrait ref |
| `desktop` | `≥ 768` | §1–§8 exactly as measured, at any width above the edge |

⚠ **The desktop layout does not move.** Everything below is what happens *under*
`md`; at 768 and up the geometry is the one the rest of this document measures,
to the pixel. A change that "improves" the desktop while making a phone work is
out of scope by definition.

| Element | desktop `≥ 768` | mobile `< 768` |
|---|---|---|
| Sidebar | Full, resizable (§2), collapsible to a 60 rail by the hamburger | Off-canvas drawer over the listing, opened from the topbar |
| Brand (mark + name) | In the sidebar | In the topbar, and in the drawer; one size (18) in both |
| Search | Field, cap 760 (560 with the assistant open) | Icon; the field then takes the whole bar, and `←` leaves it |
| Theme / help / settings | Icon buttons in the topbar | In the account menu |
| Breadcrumbs | Full, folding (§7b) | "← + current folder"; the rest stays in the fold menu |
| Filter row | One row (§7a) | Chips scroll sideways; the name filter takes its own row |
| New | Button in the sidebar (§2) | `+` in the listing toolbar — and *only* there: the drawer carries no New entry |
| Details | In flow at the right, resizable (§3) | Bottom sheet, `max-height: 70dvh`, the §3 tabs unchanged |
| Assistant | In flow at the right, resizable (§6) | Full screen |
| Grid | `minmax(176px, 1fr)` (§3) | unchanged — two columns at 390 |
| List | Every column (§4) | Name + ⋮ only |
| Trays | Bottom-right, 360 (§7) | Full width less a 12 gutter, at the bottom |
| Modals | §5 / §8 widths | Width capped to the viewport less 32, height to `100dvh − 32`, body scrolls; the advanced-search and settings modals become full-screen sheets |

**Touch density.** Where the pointer is coarse *and* the window is under `md`,
the three control heights in §1b step up (28 → 40, 34 → 44, 40 → 48) so every
control clears the 44px a finger needs. This happens in `tokens.css` alone: no
component knows about it, and a touch-screen laptop at desktop width keeps the
drawn geometry.

**Leaving the search.** The phone's `←` returns to the route the search was
*started* from, not one step of history: refining a query pushes a `/search`
entry each time, so `back()` walks the previous queries instead of leaving the
search, and a shared `/search?q=…` link has nothing behind it (there it goes
home). On the results route the field cannot be collapsed — there the field *is*
the query.

**Gestures.** A tap opens (a folder, a file's preview); a long press is the
context menu the right button gives a mouse; a double tap on a file opens the
details sheet at full height. A downward swipe dismisses: the details sheet, by
its grabber, and the preview, anywhere on the stage that is not scrollable
text. In the preview a sideways swipe steps through the listing — left for the
next file — and the axis a drag is more of decides which of the two it is. The
preview's image does not pan under a finger: there is no pinch to zoom, so the
image is always whole and the drag belongs to these two gestures.

**A gesture ends where it started.** What a swipe dismisses is gone before the
finger is lifted, and the browser gives the rest of that gesture — the release
and the click it synthesises — to whatever is under the finger by then. Both
halves are refused: a release is only a tap where its own press landed (and
never after a `pointercancel`, which is the browser taking the gesture for a
scroll), and the click is swallowed for as long as one gesture's tail can be.
Without this, swiping the preview away opened the card it was dropped on.

**Every control clears 44.** The density tokens raise the control heights, but
they cannot reach a size passed as a prop — the 22px breadcrumb chevron, the
28px filter field. `.touch-target` (`main.css`) puts a `min-width`/`min-height`
floor of 44 under a coarse pointer on those, which outranks the inline size, so
the glyph keeps its drawn size and only the hit grows.

**Menus render at the `<body>`.** `FloatingMenu` is placed in viewport
coordinates, and `position: fixed` is still clipped by an ancestor that is a
containing block for fixed descendants — a `mask-image`, a `transform`. The
chips' side-scroller is masked, which left every chip menu below `md` in the DOM
and painted nowhere.

**The phone's panels are modal.** Backdrop, Escape, a focus trap, and focus
handed back to the control that opened them — an overlay without those is a trap
for anyone not using a mouse. The details panel therefore also starts *closed*
below `md`: on the desktop it is a column beside the listing, but an overlay that
is open on arrival is a page you have to dismiss before you can read anything.

**Viewport units.** `dvh`, never `vh`: mobile browsers count the address bar
into `vh`, which put the bottom of a full-height sheet under it.

**Not in scope.** Dragging with a finger: DnD stays a mouse affordance and
"Move to…" in the item menu is the move path everywhere. Phone landscape and
widths below 360 are not drawn.
