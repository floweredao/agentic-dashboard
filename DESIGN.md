# Design

The visual contract for the web app in `src/`. Tokens live in `src/styles/tokens.css`. Change this file together with the UI.

## Identity

A quiet reading desk. Items arrive from agents, wait in the inbox, are read in a calm editorial pane and confirmed with one action. Chrome stays achromatic. Color shows up only as agent identity (small dots and tiles) and one accent for unread state and focus. No mascots, slogans or cheerleading copy.

The signature moment is the reader: a 9,000-character report should read like a well-set article.

## Color

Light is the default; dark follows `prefers-color-scheme`. Both use the same token names.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--canvas` | #f5f5f3 | #111111 | App background, sidebar |
| `--surface` | #ffffff | #181818 | List and reader panes, dialogs |
| `--raised` | #fafaf9 | #1f1f1f | Inset blocks, inputs |
| `--wash` | #1a1a1908 | #ffffff0a | Hover |
| `--selected` | #1a1a1910 | #ffffff12 | Selected row, current nav item |
| `--line` | #1a1a1914 | #ffffff14 | Hairlines |
| `--line-strong` | #1a1a1924 | #ffffff24 | Inputs, dividers that must read |
| `--ink` | #191918 | #f2f1ee | Titles, primary button fill |
| `--text` | #3b3b38 | #d4d2cd | Body |
| `--muted` | #6d6c67 | #9c9a94 | Secondary text |
| `--faint` | #716f69 | #8c8a84 | Meta, placeholders |
| `--on-ink` | #ffffff | #111111 | Text on the primary button |
| `--accent` | #4a57d6 | #8b95ff | Unread dot, links, focus ring |
| `--danger` | #b42335 | #ff7a88 | Errors, delete |
| `--ok` | #16875c | #4fd19a | Confirmed state |
| `--scrim` | #0f0f0e59 | #000000a6 | Dialog backdrop |

The `--ch-*` tokens give each agent channel its own color. State is shown with washes, weight, dots and glyphs. Never put a colored side border on a row or card; the focus ring (2px `--accent`, 2px offset) is the only colored edge.

## Typography

System fonts only: `-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif`, and `ui-monospace, "SF Mono", Menlo, monospace` for code. Korean text uses `word-break: keep-all`; URLs use `overflow-wrap: anywhere`.

| Role | Size / line height | Weight |
|---|---|---|
| Reader title | 24px / 1.35 | 700 |
| Page title | 20px / 1.3 | 700 |
| Reader body | 16px / 1.75 | 400 |
| Reader h2 / h3 | 19px / 1.4, 17px / 1.45 | 700 |
| Row title | 14.5px / 1.4 | 600 unread, 500 read |
| UI text | 14px / 1.5 | 500 |
| Row summary | 13px / 1.5 | 400 |
| Meta, chips | 12px / 1.4 | 500 |
| Section label | 11.5px / 1.3 | 600 |

Numbers use tabular figures.

## Spacing and layout

A 4px base: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56. Radii: 6 (chips, small buttons), 8 (buttons, inputs, rows), 12 (panes, dialogs, cards), 999 (dots, counts).

- **Sidebar (every width):** one 248px panel (at most 86vw) whose head holds the app name and Hide sidebar. Breakpoints follow available space, not device: iPad windows top out at 1376pt and a full-screen desktop browser starts around 1440px.
- **1400px and wider:** the sidebar docks beside the list and reader by default. Hide sidebar folds it away and the 52px app bar (Show sidebar, app name, new item, refresh) folds in; the choice is stored per device (`localStorage agentic:sidebar` = shown | hidden).
- **768 to 1399px:** list and reader only, with the app bar. Show sidebar slides the panel over the panes with a scrim; nothing is stored.
- **Over the panes (split and phone):** opens from Show sidebar, `⌘\` / `Ctrl+\` (on wide windows it docks and undocks) or a touch drag from the left 20px edge (record rows leave that strip to it); closes with Hide sidebar, Escape, a tap on the scrim, a leftward drag, choosing a destination, opening a dialog or a resize that changes layout. While it is open the app bar, main and tab bar are inert and focus moves into it; on close focus returns to Show sidebar. Opening or closing never adds a history entry.
- Views with a detail split into a list pane (`clamp(300px, 30vw, 400px)`) and a reader pane, each its own labelled scroll container.
- **Below 768px:** one column with document scroll, a 52px app bar and a 60px bottom tab bar plus safe area. Five tabs: Inbox, Library, Digest, Tasks, More. Selecting a record replaces the list with the reader; back returns to the same list, filters and scroll position.
- Nothing overflows horizontally at 320px. Chip groups wrap.

Routes are hash based and the URL owns committed state: `#/inbox`, `#/library`, `#/digest`, `#/work`, `#/more`, `#/archive`, `#/trash`, `#/channels`, `#/settings`, an optional `/<id>`, and query filters.

## Components

- **Buttons:** 34px tall, radius 8. Primary is ink fill with on-ink text; ghost and quiet variants for the rest. Pressed opacity .7, disabled .45.
- **Chips:** 28px, fully rounded, 12px text, count in muted tabular figures; selected is ink fill (`aria-pressed`). Touch targets reach 44px.
- **Record row:** title on one line, summary clamped to two lines, a meta line with agent, kind and dates. Unread rows get a 6px accent dot and heavier title. The whole row is one link.
- **Swipe (touch only):** right archives, left deletes to the trash. The axis locks after 10px; the row commits at 40% of its width or 120px.
- **Reader:** meta, title, dates, then a sticky action bar (primary action first, then star, edit, share and a menu). Content shows the conclusion and summary on `--raised`, then the Markdown body (rendered to elements, never raw HTML), next actions, links as cards and tags. Max width 68ch.
- **Menus:** APG menu button pattern with arrow keys, Home, End and Escape returning focus.
- **Listen:** commands live in the reader menu. A running job is one status line with its stage, real progress only when a done/total exists, and a cancel button that says it's cancelling until the server confirms.
- **Dialogs:** native `<dialog>`, radius 12, a bottom sheet on phones.
- **Toasts:** bottom center, ink fill, `role=status`, 4 seconds (6 with Undo).
- **Empty states:** a 20px muted icon and one factual line.
- **Demo badge:** in demo mode only, a small outlined "Demo" chip (11.5px, `--muted`, `--line-strong` border) beside the app name in the sidebar and app bar.

## Motion

Motion only marks state change: the sidebar slides in 240ms (docking also moves the panes over and folds the app bar on the same curve; a touch drag follows the finger and commits like a row swipe), 120ms hover and selection washes, 180ms swipe settle, 160ms toast and dialog entry. `prefers-reduced-motion: reduce` removes all transitions.

Keyboard: `j` and `k` move through lists, `Enter` opens, `e` confirms, `s` stars, `c` or `n` opens a new save, `/` focuses search. Shortcuts ignore text fields and modifier keys.

## Depth

Panes sit on the canvas separated by hairlines, without shadows. Only dialogs and toasts carry a shadow. Inset content uses `--raised`.

## Accessibility

Landmarks for navigation, main content, the list pane and the reader article. One visible focus ring everywhere, 44px touch targets on phones, labelled icon buttons. Color is never the only signal: unread is a dot, a weight and words in the accessible name. Every string exists in English and Korean.
