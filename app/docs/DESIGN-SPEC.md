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
danger `#f87171`, highlight `#6b5a17`, hover card/row `#1b1e25`, overlay
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
- Row 1 (h 72): burger icon 22px at x 40 center (inert, "Coming soon"); logo mark 32×32 radius 8 primary
  with white folder glyph at x 84; word "filex" 22/600 at x 132.
- **New** button: x 22, y 82, w 136, h 52, radius 12, primary bg, white
  `Plus` 20px + "New" 18/500, gap 12. Opens a dropdown (Folder, File upload,
  Folder upload, divider, New document).
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
  Selected card: border 2px `--c-primary-ring`, bg `--c-primary-tint`.
  Hover: bg `#fafbfc`, border `#d1d5db`.
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
  Hover: bg `#f9fafb`. Column widths: name flex, owner 160, modified 236, size
  160, menu 60 (the 48 of the ref plus the 12px the table extends past the ⋮:
  a 48 column would widen the flex name column and push Owner off x 1035).
- Right of filter chips: sort control pill h 40 border 1px: "Name" 15 +
  `ArrowUp` 16 + divider + `ChevronDown` 16 (x 1502..1650).
- Keyboard: ↑↓ move focus, Space toggles, Enter opens, Delete → trash, F2 rename,
  Ctrl/Cmd+A select all, Esc clears.

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
    icon 18; checkboxes 20 radius 5: "Match whole phrase", "Case sensitive",
    "Include document OCR" (checked, + `Info` 16 gray). Row gap 12.
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
  13 with 8px `--c-success` dot; `X` 22 right.
- Intro 15 `--c-text-3` line-height 1.5: "Find files by content, filename, or
  tags. I can also summarize files, answer questions, and help you organize
  your work."
- User message: bubble bg `--c-primary-soft` radius 14 padding 12 16, text 15,
  timestamp 12 gray below inside bubble; avatar 36 "D" at right; bubble max-w
  270, right-aligned.
- Assistant: 32 circle border 1px with `Sparkles` 16 primary at left; bubble bg
  `--c-bg-muted` radius 14 padding 12 16 text 15 line-height 1.45; timestamp 12.
- Result card (full width, border 1px radius 12 padding 14, gap 12 between):
  icon 40 (pdf tile red radius 8 / fig / md), name 16/500, path 14 gray,
  "Matched content: "…"" 14 gray (wraps), `MoreVertical` 20 top-right.
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
  15 with 18px icon: Open, Preview, Download, Share, Rename, Move to, Copy to,
  Add to starred, Tags, Version history, Manage access, divider, Move to trash
  (red `#dc2626`).
- **Modals** (Rename, New folder, Delete, Share): radius 16, w 480, padding 26,
  title 20/600, inputs h 44, footer buttons h 44 radius 10.
- **Pages** Home / Shared with me / Recent / Starred / Trash: same content
  frame; header row with title 22/600; Recent groups by day ("Today",
  "Yesterday", "Jul 5"); Shared with me adds "Shared by" column; Trash adds
  "Deleted" column and a top banner "Items in trash are deleted forever after
  30 days" with "Empty trash" button.
- **Selection bar** (appears above table when ≥1 selected): h 48, "3 selected",
  icon buttons Download, Share, Move, Star, Delete, `X` clear.
- **Toasts** bottom-left, radius 12, shadow-menu.
- **Upload tray** bottom-right card w 360 with per-file progress.

## 8. User settings modal (ref 5)

Opened by the topbar gear or by Account → User settings; hosted by the shell,
so it is reachable from every page. Panel 808 wide, max height 850, radius 16,
padding 20. Header: 44 avatar, title 20/600 "User settings", subtitle 14 in
`--c-text-3`, close X top right. Body below it: nav 142 wide (5 items, h 40,
icon 18 + 15px label, active on `--c-primary-soft` in primary), then the
content box (`--c-border`, radius 12, padding 14) which is the only scrolling
area. Footer above the panel edge: 1px separator, Cancel (outline) and Save
changes (primary), both h 44.

The content is one column of cards (radius 12, border, padding 16, 16/600
heading + 13 caption): Profile full width, then a two-column grid
(`1fr` / 236) with Preferences, Storage & uploads and Notifications on the
left, Security and AI assistant on the right. The nav scrolls to a card and
highlights whichever card has passed the top edge.

Controls: Profile — 62 avatar with a camera badge, name + role pill + email,
Change photo / Remove, then Full name, Display name, Email (read-only, muted)
and Job title in a 2×2 grid. Preferences — Language and Time zone selects,
Theme as a 3-segment control (Light / System / Dark, h 36), "Use compact file
list" checkbox with a caption. Storage & uploads — default upload folder
select, an auto-open-preview switch (44×24), upload conflict select.
Notifications — three switches with captions. Security — three 52-high rows
(icon, title 13/500, caption 12, chevron) and a Manage security button.
AI assistant — enable switch, default search mode select, a note that the
provider is set by the administrator.

Editing works on a copy: Cancel drops it, Save changes commits everything at
once. Theme, language and the compact list take effect immediately; the
profile fields, notification switches, photo buttons and every Security row
are mocks until the backend grows the endpoints (see BACKEND-GAP.md).

## 9. Mock data (matches the refs)

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
