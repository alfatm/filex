# filex user UI — design spec (from reference screenshots)

Source of truth for the new end-user SPA in `app/`. Four reference screenshots
exist (the orchestrator sees them; agents work from this document). Numbers are
measured at the reference size **1672 × 941 CSS px** (treat this as the baseline
viewport for screenshot comparison). Colours are approximations of the refs and
may be tuned by overlay comparison.

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

Type scale (px / weight): 22/600 logo, 20/600 panel & modal titles, 18/600
breadcrumb current, 17/600 section titles ("Folders", "24 matching items"),
16/500 nav items and item names, 16/600 side-panel headings, 15/400 body,
table cells, filter chips, 14/400 meta, 13/400 small meta, 12/600 uppercase
captions (letter-spacing .06em). Body line-height 1.5, single-line rows 1.

Icons: lucide, 20px stroke 1.75 in nav, 22px in topbar, 18px in chips/buttons.

## 2. Shell (every page)

```
┌ sidebar 280 ┬ topbar h72 ───────────────────────────────┬ right panel (optional) ┐
│             ├ content x 309..1651 (see §3/§4)             │ 364 details / 432 AI  │
```

Content padding: the column starts at x 309 (29px from the sidebar) with the
breadcrumb row at y 90 and ends at x 1651 (or 1297 with the details panel
open); §3/§4 are authoritative where an earlier draft said "padding 28 32".

**Sidebar** (w 280, bg `--c-bg-sidebar`, border-right 1px):
- Row 1 (h 72): burger icon 22px at x 40 center (collapses the sidebar, see §7b); logo mark 32×32 radius 8
  primary with white folder glyph at x 84; word "filex" 22/600 at x 132.
- **New** button: x 14, y 82, w 180, h 52, radius 12, primary bg, white
  `Plus` 20px + "New" 18/600, the two centred in the button as the ref draws
  them (not aligned to the nav columns below). A 44px `ChevronDown` cell closes
  the right end behind a 1×28 white/25 rule, centred rather than full height; it
  is an affordance, not a second action — both halves open the same dropdown
  (Folder, File — disabled until a backend, divider, Upload files, Upload folder).
- Nav list starts y 156, item h 40, gap 1, padding-left 24 (icon), text at x 70,
  icon 20px. Active item: bg `--c-primary-soft`, radius 10, extends x 14..260.
  Items: Home, My files, Shared with me, Recent, Starred, Trash.
- Caption "STORAGES" at y 438 (12/600 uppercase, `--c-text-3`, x 26); storage
  items same geometry as nav (icon `HardDrive`), active state identical.
- Caption "CONNECTIONS" at y 530; items "How to connect" (`Cable`), "API keys"
  (`KeyRound`) — inert for now ("Coming soon").
- Quota block pinned bottom, x 26, bottom 34: storage name 15/600, "12.4 GB of
  100 GB used" 13 `--c-text-3`, progress bar h 6 radius pill bg `#e5e7eb`,
  fill primary, w 234.

**Topbar** (h 72, white, border-bottom 1px):
- Search box: x 322 (42px from sidebar), h 48, radius 14, bg `--c-bg-muted`,
  `Search` icon 20 at left padding 20, placeholder "Search in {storage}…"
  16 `--c-text-3`. Width fills to 1180 (right icons start at 1400). Right end:
  `SlidersHorizontal` 18 icon button 32 (opens the Advanced search modal;
  product addition, not in the ref), then two kbd chips "⌘" "K" 24×24 radius 6
  border 1px bg white 12px, gap 4, right padding 20. Enter in the box runs a
  quick search (`/search?q=…`, all filters default); the modal is the
  separate advanced search. When the AI panel is open the box ends at x 962.
- Right cluster (icons 22px `--c-text-2`, hit area 40×40, gap 8): `Sparkles`
  (opens the AI assistant; hidden while the panel is open so the bar keeps the
  reference width), `LayoutGrid` (view/apps), `Settings`, `HelpCircle`, then
  avatar 36 circle bg `--c-primary-soft` letter 15/600 primary, then
  `ChevronDown` 16. Apps / Settings / Help / Account are inert for now
  (`aria-disabled`, tooltip "Coming soon", no dimming).

## 3. Page: My files — grid + Details (ref 1)

Content column x 309..1297 when the details panel is open (panel x 1322..1640).

- **Breadcrumb row** y 90..128: `Home` icon 20 at x 320 (goes to the storage
  root), `ChevronRight` 16 gray, "demo" 18/600, `ChevronRight` 16 (dropdown of
  sibling folders; inert for now).
- Right side of that row: segmented view toggle x 1141..1240 h 40 radius 10
  border 1px: two 48px cells, `List` and `LayoutGrid` icons 20; active cell bg
  `--c-primary-soft` icon primary. Then `Info` button 44×40 radius 10 border 1px
  at x 1254 (toggles details panel; filled tint when open).
- **Filter chips** row y 140, h 38, pill, border 1px, bg white, text 15 +
  `ChevronDown` 16, padding 0 18, gap 10: Type (w 94), People (106), Modified
  (120), Size (92) — inert for now ("Coming soon"). Right-aligned: "Name" 15 +
  `ArrowUp` 16 (sort), then `MoreVertical` 20 at x 1276 (inert).
- Section title "Folders" 17/600 at y 222; grid starts y 252: 4 columns, card
  w 236, gap 14; folder card h 84, radius 12, border 1px, bg white, padding 0 20.
  Content: `Folder` filled icon 36×30 `--c-folder`, name 16/500 at x+80, meta
  "12 items" 14 `--c-text-3` below (line gap 4), `MoreVertical` 20 gray at right
  (x+212). Shared folder shows a small people glyph inside the folder icon.
  Selected card: `--c-primary-ring` edge 2px wide, bg `--c-primary-tint`. The
  edge is a 1px border plus a 1px outline, not a 2px border: a border comes
  out of the content box, which shifts the thumbnail and rounds its top
  corners at the wrong radius. Outline changes no layout.
  Hover: bg `--c-hover-card`, border `#d1d5db`; cursor `pointer`.
- Section title "Files" 17/600 at y 484; file card w 236 h 174 radius 12 border
  1px overflow hidden: thumbnail area h 108 (image cover / dark code block /
  document page mock / video with centered 44px play circle and duration badge
  "02:14" bottom-right 12px on rgba(0,0,0,.65) radius 6); footer h 66 padding
  0 14: type tile 28×28 radius 6 (colour by kind: md `#374151`, image
  `#2f6ceb`, ts `#2f6ceb`, pdf `#dc2626`, fig multicolour, csv `#16a34a`,
  mp4 `#7c3aed`) with white glyph, name 15/500, meta "2.4 KB • Jul 10, 2026"
  13 `--c-text-3`, `MoreVertical` at right.
- Empty state: centered illustration + "Drop files here or use New" 16 gray.

**Details panel** (w 364 flush right, border-left 1px, padding 20 22 with 33
on the left). The ref draws a 320 panel at x 1322 with white to its right; here
the panel is flush right and 364 wide so the content column still ends at
x 1297 (4 × 236 + 3 × 14 from x 309), and the extra left padding keeps the
labels at x 1342 / values at x 1440 below.
- Header y 100: `Folder` icon 52×44 amber, name 20/600, meta "Folder • 8 items"
  14 `--c-text-3`; `X` 22 at top-right.
- Tabs y 190..236: "Details" | "Activity", each 50%, 16/500, active primary with
  2px primary underline, strip bottom border 1px.
- "General" 16/600 at y 268; rows (label `--c-text-3` 15 at x 1342, value
  `--c-text` 15 at x 1440, row h 31): Type, Location, Size ("—" for folders),
  Modified "Jul 8, 2026, 11:24 AM", Created, Owner "You".
- Divider 1px at y 494.
- "People with access" 16/600; row: avatar 36 + name 15 + role 13 gray.
- Divider. "Shared link" 16/600; row: `Link` icon in 32 circle `--c-bg-muted`,
  "Not shared" 15 gray; right button "Create link" h 40 radius 10 border 1px
  15/500. When shared: URL text truncated + `Copy` icon button + "Remove".
- Activity tab: vertical list of events (avatar, "You renamed …", time),
  version entries and comments, newest first.

## 4. Page: My files — list view (ref 2)

Details panel closed; content x 309..1651.
- Table header y 200..238: checkbox 20×20 radius 5 border 1.5px at x 320;
  "Name ↑" 15 `--c-text-2` at x 372 (clickable sort, icon 16); "Owner" at
  x 1035; "Last modified" at x 1197; "File size" at x 1433. Header
  border-bottom 1px `--c-border`.
- Row h 42, separator 1px `--c-border-soft`, padding 0 12: checkbox at x 320,
  icon at x 372 (folder 32×26 amber; file: 32×32 thumb radius 6 or type tile),
  name 16/500 at x 424, "12 items" 15 `--c-text-3` at x 520 (folders only),
  owner 15, date 15 "Jul 8, 2026, 11:24 AM", size 15 ("—" for folders),
  `MoreVertical` 20 at x 1618.
- Selected: bg `--c-primary-soft`, checkbox filled primary with white check.
  Hover: bg `--c-hover-row`; cursor `pointer`. Column widths: name flex, owner 160, modified 236, size
  160, menu 60 (the 48 of the ref plus the 12px the table extends past the ⋮:
  a 48 column would widen the flex name column and push Owner off x 1035).
- Right of filter chips: sort control pill h 40 border 1px: "Name" 15 +
  `ArrowUp` 16 + divider + `ChevronDown` 16 (x 1502..1650).
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
    radius 10 border, `Calendar` 18, "Any time", `ChevronDown` right.
    "File type" → select with `File` icon "Any file type". "Tags" → input
    "Add or select tags…" h 40, below it chips (pill h 28 bg `--c-primary-soft`
    text primary 14 + `X` 14): "design", "project alpha".
  - Right: "Owner" → select `User` "Any owner". "Size range" → row: select "Any
    size" w 94, input "Min" w 70, "–", input "Max" w 70, select "MB" w 62, all
    h 40, gap 8. "Path" + help → input "/demo/design/" h 40, hint "Example:
    /demo/design/" 13 gray. "Content search options" 15/600 with `FileText`
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
  have looked like it worked.
- Permission card (below the answer that raised it, full width, border 1px
  radius 12 padding 16): "May I open this file?" 14/500, the full address 14
  gray (breaks anywhere — an address is longer than the panel), the assistant's
  own stated reason 13 gray, then two 36px pill buttons — primary "Allow this
  file", outlined "Not this one". Once given, both are replaced by a green 13
  line. **Not in the reference**, which was drawn before the assistant could
  open anything. One card per file, always: there is no button anywhere in this
  flow that approves more than the one file it names.
- Plan card (same box as the permission card): the assistant's one-line summary
  14/500, then EVERY item on its own line — the full address, an em dash, what
  will happen to it, and a second 12 gray line with its size and date. Two pill
  buttons, primary "Approve and run" and outlined "Don't do this"; after the
  decision they are replaced by the refusal line, or by "Done" and a per-item
  outcome list. Also not in the reference.
  **The whole list is always drawn, never a count.** A card reading "12 changes"
  with an Approve button is a button with nothing behind it — the plan is
  approved by reading it.
  ⚠ The item wording and the numbers come from the SERVER as a code plus raw
  values (`tag`, `purge`, a byte count, an ISO date), and the panel renders them
  through i18n and its own formatters. The first version had the server compose
  the sentence, which put "44 bytes, deleted 2026-09-08T13:47:58Z" into a
  Russian conversation.
- Activity line (13 gray with a spinning `Loader2` 14, under the last message
  while a tool runs): "Looking in main://Docs", "Reading …". Also not in the
  reference. It exists because a turn that lists a folder, searches and then
  answers is twenty silent seconds otherwise, which reads as a stall.
- Intro 15 `--c-text-3` line-height 1.5: "Find files by content, filename, or
  tags. I can also summarize files, answer questions, and help you organize
  your work."
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
- Result card (full width, border 1px radius 12 padding 14, gap 12 between):
  icon 40 (pdf tile red radius 8 / fig / md), name 16/500, path 14 gray,
  "Matched content: "…"" 14 gray (wraps), `MoreVertical` 20 top-right.
  Drawn from the `hits` frame the server sends whenever the assistant ran a
  search — the same rows the model reads as JSON — and stored with the answer,
  so reopening the conversation redraws them. The snippet's matched words
  arrive wrapped in « » and are turned into highlight ranges, never shown as
  those characters.
- Follow-up line 15 + timestamp 12.
- Mode chips h 38 pill: "Filename" active primary bg white text with `File`
  16; "Content" (`Search`), "Tags" (`Tag`) bordered; gap 10.
- Suggestion chips h 36 pill bordered 14: "Find contracts from July",
  "Search by tag: design".
- Input row bottom: textarea h 56 radius 12 border 2px primary (focused) /
  1px `--c-border` (idle), placeholder "Ask to find files…" 15; send button
  56×56 radius 12 primary with `Send` 22 white; gap 10. Hint below 13 gray:
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
  320. A node's own subtree is never a destination. The folder the nodes already
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
query params. Nothing is narrowed after the fact in the client.

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
  the query behind the chips.
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
  exist; the folders appear at once, the files as their transfers finish.

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
overrides the snapshot in dev builds.

**Tags** are edited in their own modal (item menu → Tags): a text field that
takes one tag per Enter, the current tags as removable chips, Cancel / Save,
and the whole list written in one call. A tag still in the box when Save is
pressed counts as typed. The details panel deliberately does not show tags —
the panel is a reference state (ref 1) and the folder it shows is tagged, so a
tags row there would move everything below it; revisit when the refs do.

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
Owner "You" everywhere; user "D" (demo). Thumbnails: images and the video
render the real files of the demo asset tree (`drive-demo-assets/demo`, see
DEMO-ASSETS.md — generator, `DEMO_ASSETS_DIR`, the `REF_OVERRIDES` table that
pins the 16 root entries to the values above); the SVG/CSS placeholders
(mountain, beach, code block, doc page, spreadsheet, figma shapes, video
gradient) stay as the fallback when the assets are not served. demo.mp4 shows
the real duration (00:30) once the browser reads it.
