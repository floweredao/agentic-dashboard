# Design

The visual contract for the web app in `src/`. Tokens live in `src/styles/tokens.css`. Change this file together with the UI.

## Identity

A quiet reading desk. Items arrive from agents, wait under To review on Home and in the Library, are read in a calm editorial pane and confirmed with one action. Chrome stays achromatic. Color shows up only as agent identity (small dots and tiles) and one accent for unread state and focus. No mascots, slogans or cheerleading copy.

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
| Persistent meta (`--text-meta`) | 13px / 1.4 | 500 |
| Section label (`--text-label`) | 13px / 1.4 | 600 |
| Compact chips | 12px / 1.4 | 500 |

Numbers use tabular figures.

Persistent labels in Home, Library, Digest, Settings and navigation use the 13px tokens, expressed in rem so browser text enlargement scales them. Compact transient indicators may remain smaller.

## Spacing and layout

A 4px base: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56. Radii: 6 (chips, small buttons), 8 (buttons, inputs, rows), 12 (panes, dialogs, cards), 999 (dots, counts).

- **Sidebar (every width):** one 248px panel (at most 86vw) whose head holds the app name (15px there, so a name as long as "Agentic Dashboard" fits whole; longer names end in an ellipsis) and Hide sidebar. In demo mode the Demo badge, with the release ("Demo · v0.4.0"), sits on its own line in the sidebar foot above the sync time, so it never squeezes the name; the phone app bar keeps the short "Demo" beside the name. Breakpoints follow available space, not device: iPad windows top out at 1376pt and a full-screen desktop browser starts around 1440px.
- **1100px and wider:** the sidebar is a column of the layout. Folding pulls it left by its own width (`margin-left`) while the list and reader fill the room; unfolding pushes them back. It starts unfolded from 1400px and folded below (iPad landscape: two columns) until the owner chooses; the choice is stored per device (`localStorage agentic:sidebar` = shown | hidden).
- **768 to 1099px:** three columns don't fit, so Show sidebar slides the panel over list and reader with a scrim; nothing is stored.
- **From 768px there is no app bar:** while the sidebar is not docked, its opener Show sidebar (`SidebarOpen`, `.sidebar-open`) sits before the title of the screen's first pane (every `.pane-title-row`), and Hide sidebar in the sidebar head is its counterpart, so only one of the two shows. Phones keep the app bar's menu button.
- **Opening and closing:** Show sidebar, Hide sidebar, `⌘\` / `Ctrl+\`, a touch drag from the left 20px edge (record rows leave that strip to it) and a leftward drag on the panel. Over the panes (split and phone) it also closes with Escape, a tap on the scrim, choosing a destination, opening a dialog or a resize that changes layout, and the app bar, main and tab bar are inert while it is open. Focus moves to Hide sidebar when the sidebar appears from its opener and back to the opener when it goes. Opening or closing never adds a history entry.
- Views with a detail split into a list pane (`clamp(300px, 30vw, 400px)`) and a reader pane, each its own labelled scroll container.
- **Below 768px:** one column with document scroll, a 52px app bar and a 49px minimum bottom tab bar plus safe area (growing with enlarged text). Four tabs: Home, Digest, Library, More (Home, Library, More while digests are off); Library carries the To review count, Digest the unread parts (a 16px count badge on the glyph's top-right corner with a 2px canvas ring, as on an iOS tab bar), and More stays marked on Tasks, Trash, Channels and Settings. The desktop sidebar lists the same tabs, then a More section with Tasks, Trash, Manage channels and Settings; it has no channel list. Selecting a record replaces the list with the reader; back returns to the same list, filters and scroll position.
- Nothing overflows horizontally at 320px. Chip groups wrap.

Routes are hash based and the URL owns committed state: `#/home` (the first screen), `#/library`, `#/digest`, `#/work`, `#/more`, `#/trash`, `#/channels`, `#/settings`, an optional `/<id>`, and query filters. Old addresses redirect (`router.legacyRedirect`, also on hashchange): `#/today` and `#/inbox` to `#/home`, `#/inbox?state=pending|starred` and `#/inbox/<id>` to the same under `#/library`, `#/archive[/<id>]` to `#/library[/<id>]?state=archived`, and `type`/`channel` on `#/library` drop.

## Components

- **Public entry and setup:** the entry layer owns public `/privacy` and `/terms`,
  sign-in, and the hosted `/welcome` journey. Signed-out visitors get no sidebar,
  menu opener, tab bar or navigation listeners. The authenticated dashboard keeps
  its existing route lifecycle, including returning to the first screen after
  leaving and reopening the app; setup adds no route-resume storage.
- **Welcome:** a constrained 720px column, semantic numbered steps, a quiet
  progress label, Back and one primary Continue/Finish action. Language, agent
  connection, digests, optional Gemini and phone setup reuse existing field,
  button, dialog and settings primitives. A copied token or browser-only test
  is not activation: an explicit Check agent save reads server proof from an
  external bearer save. Gemini and phone setup can be skipped; there is no
  automatic audio consent. No new colors, imagery or motion tokens.
- **Account controls:** settings sections provide an account email, persisted
  language/calendar zone, Replay setup, export download and a separate destructive
  deletion dialog; on a phone the deletion card keeps the 16px page gutter like the other grouped cards. Deletion requires typed email; reauthentication returns to
  confirmation without submitting it. Export and backup retention explanations
  are inline with the actions. Legal pages use the existing reader body scale and
  42rem measure, ordinary links and a document-owned scroll.
- **Library paging and freshness:** the visible list grows in 50-record batches
  through an ordinary outlined button; a selected deep-linked record stays visible.
  Refresh uses account-scoped change pages after an initial snapshot. A failed
  refresh leaves the last successful data visible and shows a neutral Retry
  notice; no route is persisted or restored on app return.
- **References and constraints:** StyleGallery `sg:layout/saas-settings` supplies
  the semantic section stack and content limiter (installed CLI, because no
  StyleGallery MCP tool was available). Setup uses document scrolling; the
  existing Settings main pane owns desktop scroll, and the document owns phone
  scroll. Long emails, code/configuration text and URLs wrap without horizontal
  page overflow. Keyboard focus, 44px phone targets, en/ko and light/dark are
  required. Existing production dependencies and dev tooling remain in place;
  this scoped journey change does not install unrelated instrumentation.

- **Hosted sign-in:** reuse the centered gate and system typography, with a single Google action, Google-only/limited-capacity disclosure before authorization, and Privacy/Terms links. Google’s multicolor G is an identity-provider mark, not an application illustration. The provider button follows Google's light-button colors (`#ffffff`, `#1f1f1f`, `#747775`) and 40px minimum height (44px touch target); these are isolated provider-brand exceptions, not new app tokens. Capacity failures use a plain reading page with a self-hosting alternative and no repeat-authorization prompt.
- **Hosted credential settings:** follow StyleGallery `recipes/saas-settings.md`: semantic sections in a constrained vertical stack; the existing main pane owns desktop scroll and the document owns phone scroll. Agent secrets appear once in a dialog with copy acknowledgement and an actual test-save result; key settings use a password field and report “Key accepted”, never guaranteed audio availability. Chrome, spacing, focus and errors reuse existing primitives.

- **Buttons:** 34px tall, radius 8. Primary is ink fill with on-ink text; ghost and quiet variants for the rest. Pressed opacity .7, disabled .45.
- **Chips:** 28px, fully rounded, 12px text, count in muted tabular figures; selected is ink fill (`aria-pressed`). Touch targets reach 44px.
- **Record row:** title on one line, summary clamped to two lines, a meta line with agent, kind and dates. Unread rows get a 6px accent dot and heavier title. The whole row is one link. Rows under Archived, which mix kinds, start with a 28px category tile (radius 8, `--raised`) carrying the tab bar's icon: Library or Tasks; other lists have no tile.
- **Library (`#/library`):** the former Inbox, Library and Archive in one list: a search field, then one Record status chip group, All (default: every unarchived material, newest first), To review (`state=pending`: the pending or revisit-due queue, with an N to revisit note), Favorites (`state=starred`: unarchived starred material; digests have no star) and Archived (`state=archived`: archived records of any kind, most recently archived first), each counting what the search leaves. No kind, channel or topic chips. Under All without a search, a record that a later listed record continues (`fields.previousId`) folds under it behind a quiet "N earlier records" toggle, indented, newest first, and unfolds while one of them is open. Under To review and Favorites the open record keeps its row while selected.
- **Home (`#/home`):** the first screen, a single 720px column titled Home, with no date and no day boundary (a day brings few records): sections in outlined radius-12 cards: Latest digest (the latest two, and All digests; only while digests are on), Recent records (the 5 newest unarchived records, continued ones folded, opening `#/library/<id>`; "N to review" to `#/library?state=pending` when any wait and See all to `#/library`), Continue listening (only while a track is loaded; it stands in for the mini player there) and Tasks (only when open tasks exist: up to 5 unfinished, unpaused tasks, those to review first, and See all to `#/work`).
- **More (`#/more`):** grouped rows: Work (Tasks with its open count), Clean up (Trash), Connections (Manage channels, N connected), App (Settings).
- **Swipe (touch only):** right archives, left deletes to the trash. The axis locks after 10px; the row commits at 40% of its width or 120px.
- **Reader:** meta, title, dates, then a sticky action bar (primary action first, then the Favorite star toggle, filled when on, then Revisit in 7 days when no revisit is due, then edit, share and a menu). On a phone the bar stays one row: every button keeps its 44px target, the menu sits at the trailing end and only the primary label shortens with an ellipsis when space runs out. Content shows the conclusion and summary on `--raised`, then the Markdown body (rendered to elements, never raw HTML), next actions, links as cards and tags. Text column up to 42rem, with 32px side padding (20px on phones), following the StyleGallery content-limiter pattern. A record with a full document opens on it: a full-width [Full document | Summary] segmented switch, the conclusion and summary briefly above, then the document edge to edge in a script-free frame, with the reader widened to 960px. A full-screen icon button (32px, 44px on phones) sits in the column's top-right corner and opens the reading content alone in a modal dialog whose Close takes the same corner.
- **Menus:** APG menu button pattern with arrow keys, Home, End and Escape returning focus. The button is a ⋯ icon (34px, 44px on phones) everywhere; its name (More) stays in `aria-label` and the tooltip.
- **Listen:** commands live in the reader menu. Make audio asks for Read aloud or Podcast (records) or which audio, the whole digest or a part (digests), as radio cards. A running job is a percent bar that eases through its real stages, says when it waits for the provider, and has a cancel button that says it's cancelling until the server confirms. A trash button beside the player, folded or playing, deletes only that audio. A closed error stays closed on this device (`agentic:listen-dismissed`), also when a retry fails again for the same reason on the same audio; another reason or new audio shows it again. A failed remake over audio that exists keeps the player and adds one quiet status line under it (the reason, Retry and the same x) instead of the alert. Playback starts at 1x and keeps a rate the listener picks.
- **Digest list filter:** All, Articles and Messages as a three-segment control; each segment is its text label and unread count on one line at every width, without glyphs (HIG: a segmented control uses text or images, not both).
- **Digest reader:** the title comes first, mark read sits in the ⋯ More beside the date title, and items read as a list: each summary's first sentence before its context, one update tag. A section bar sticks to the top and stays one row at every width: section tabs with count badges scroll sideways when they do not fit (the hidden edge fades) and underline the section being read, then Titles only as an icon toggle, which folds items to their titles, and an end line closes the digest.
- **Language:** follows the system by default. Settings is the only place to choose Follow the system, English or 한국어, stored per device (`agentic:locale`).
- **Settings recovery:** narration voices and automatic audio are independent of push. Each keeps its heading while loading and shows a text error with Retry on failure. A rate-limited action stays disabled until `Retry-After` elapses; drafts stay editable. Installed-app help states that internet is required.
- **Startup recovery:** a visible Starting the service status precedes authentication and data loading. Only unauthorized visits see sign-in; service or connection failures show an error and Retry, without a sign-in action.
- **Connection naming:** Agent connections / 에이전트 연결 names the sidebar entry, More entry and destination. Settings summaries list Language, then Voice and Notifications only when those features are enabled.
- **Layout reference:** StyleGallery `recipes/saas-settings.md` (installed CLI corpus) informed the stable section headings and constrained vertical stack. The existing main pane owns desktop scrolling and the document owns phone scrolling; sections add no scroll containers.
- **Dialogs:** native `<dialog>`, radius 12, a bottom sheet on phones.
- **Toasts:** bottom center, ink fill, `role=status`, 4 seconds (6 with Undo).
- **Empty states:** a 20px muted icon and one factual line.
- **Demo badge:** in demo mode only, a small outlined "Demo" chip (11.5px, `--muted`, `--line-strong` border) beside the app name in the phone app bar, and "Demo · v<version>" in the sidebar foot.
- **Version:** the server's version ("Version 0.4.0") closes the Settings page in 12px `--faint`, aligned with the section labels.

## Motion

Motion only marks state change: the sidebar moves in 300ms on `--slide` (`cubic-bezier(.32,.72,0,1)`, a fast start that settles softly): docked layouts animate the one `margin-left` so the sidebar's edge and the list's edge move in the same frame, the overlay animates `transform` with the scrim; the list-head opener leaves at once and fades in after 60ms; a touch drag follows the finger and commits like a row swipe, 120ms hover and selection washes, 180ms swipe settle, 160ms toast and dialog entry. `prefers-reduced-motion: reduce` removes all transitions.

Keyboard: `j` and `k` move through lists, `Enter` opens, `e` confirms, `s` stars, `c` or `n` opens a new save, `/` focuses search. Shortcuts ignore text fields and modifier keys.

## Depth

Panes sit on the canvas separated by hairlines, without shadows. Only dialogs and toasts carry a shadow. Inset content uses `--raised`.

## Accessibility

Landmarks for navigation, main content, the list pane and the reader article. One visible focus ring everywhere, 44px touch targets on phones, labelled icon buttons. Color is never the only signal: unread is a dot, a weight and words in the accessible name. Every string exists in English and Korean. Escape closes a dialog from its own keydown handler.

## Accessible reading and feedback

Account export uses a button with a preparing state, not a raw download link.
Show export-specific busy, size-limit and failure messages beside it in the
selected language; they must not disable unrelated actions. State the 64 MiB cap.
Leaving the account controls cancels an unfinished transfer and releases its
temporary browser download URL.

Text sizes use rem so text enlargement reflows. Touch pointers, including tablets, get 44px targets; list headings wrap within 320px at enlarged text sizes. Favorite changes are quiet because the pressed state supplies feedback; errors still announce. Empty Recent records offers New item. Digest loading keeps two row-shaped placeholders under a status label. Empty trash names its busy state. Reduce Motion uses fades for dialogs, toasts and the mini player. Validation errors name fields rather than schema paths.

Digest detail has the same full-screen corner control as record detail. Only its section bar and content enter the modal; audio stays mounted outside. The dialog owns scrolling and its section bar sticks below the measured header. Close or Escape restores focus. Message action lines are not displayed in either reading density. Phone tabs auto-flow into equal columns, with no unused column when digests are disabled. Check keyboard focus, accessible names, 320px reflow and touch targets in both languages.
