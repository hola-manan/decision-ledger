# Design system: Decision Ledger chat panel

**Direction.** Quiet, native VS Code: the panel looks like part of the editor (the user's theme, font, icons and density), so the eye is free to notice the few things that matter. Only two things are ever loud: **Claude's questions** and **permission prompts**. Everything else is calm text with clear hierarchy.

This fits the users because they are developers mid-task in VS Code. A chat panel that brings its own brand would compete with their code and their theme; one that reads like VS Code lets them scan a reply in seconds.

Files:
- Tokens: [`src/webview/styles/tokens.css`](../../src/webview/styles/tokens.css), shared by every webview (moved from `docs/ui/` when the grade filter shipped, D-021).
- Reference styles for every component: [`docs/ui/previews/preview.css`](previews/preview.css). This is throwaway preview code, but class names and structure are the intended shape.
- Every component in every state: [`docs/ui/previews/components.html`](previews/components.html).

## 1. How theming works

VS Code injects the active theme's colours and fonts into every webview as CSS variables (`--vscode-foreground`, `--vscode-button-background`, …) and puts `vscode-dark`, `vscode-light` or `vscode-high-contrast` on `<body>`. Our tokens are **aliases** of those variables, each with a Dark Modern fallback:

```css
--dl-color-fg: var(--vscode-foreground, #cccccc);
```

Rules:
1. Components use only `--dl-*` tokens. Never `--vscode-*` directly, never a literal value.
2. The panel defines no colours of its own; it follows dark, light and high-contrast themes automatically.
3. Font family and base size come from the user's VS Code settings. The type scale is relative to the base size.
4. In high-contrast themes `--vscode-contrastBorder` exists, and `--dl-color-border` picks it up automatically, so every border becomes visible.

The previews fake the injected variables with [`previews/vscode-theme.css`](previews/vscode-theme.css) (approximations of Dark Modern and Light Modern) so the dark/light toggle works in a browser. The extension never ships that file.

## 2. Tokens

### Colour

| Token | VS Code variable | Dark fallback | Used for |
|---|---|---|---|
| `--dl-color-bg` | `sideBar-background` | `#181818` | Panel background |
| `--dl-color-surface` | `editorWidget-background` | `#202020` | Status line, full-reply body, neutral callouts |
| `--dl-color-surface-raised` | `input-background` | `#313131` | User message |
| `--dl-color-hover` | `list-hoverBackground` | `#2a2d2e` | Row hover (file rows, full-reply toggle) |
| `--dl-color-toolbar-hover` | `toolbar-hoverBackground` | `rgba(90,93,94,.31)` | Icon button and disclosure hover |
| `--dl-color-fg` | `foreground` | `#cccccc` | Primary text |
| `--dl-color-fg-secondary` | `descriptionForeground` | `#9d9d9d` | Meta lines, section labels, diff counts |
| `--dl-color-fg-muted` | `input-placeholderForeground` | `#989898` | Placeholder text only |
| `--dl-color-link` / `-hover` | `textLink-foreground` / `textLink-activeForeground` | `#4daafc` | Text buttons, links |
| `--dl-color-border` | `contrastBorder` → `widget-border` | `#313131` | Separators, cards |
| `--dl-color-border-input` | `contrastBorder` → `input-border` | `#3c3c3c` | Composer, text areas |
| `--dl-color-focus` | `focusBorder` | `#0078d4` | Focus ring |
| `--dl-color-primary` / `-fg` / `-hover` | `button-background` / `button-foreground` / `button-hoverBackground` | `#0078d4` / `#fff` / `#026ec1` | Primary button |
| `--dl-color-secondary` / `-fg` / `-hover` | `button-secondaryBackground` / `…Foreground` / `…HoverBackground` | `#313131` / `#ccc` / `#3c3c3c` | Secondary button |
| `--dl-color-input-bg` / `-fg` | `input-background` / `input-foreground` | `#313131` / `#ccc` | Composer |
| `--dl-color-success` | `testing-iconPassed` | `#73c991` | Check icons (answered, allowed) |
| `--dl-color-added` / `-removed` | `gitDecoration-addedResourceForeground` / `…deletedResourceForeground` | `#81b88b` / `#c74e39` | The `+` / `−` signs in diff counts |
| `--dl-color-warning` | `editorWarning-foreground` | `#cca700` | Permission icon |
| `--dl-color-danger` | `errorForeground` | `#f85149` | Error icons |
| `--dl-color-attention-bg` / `-border` | `inputValidation-infoBackground` / `…infoBorder` | `#063b49` / `#1b80b2` | **Question card**, answering composer |
| `--dl-color-warning-bg` / `-border` | `inputValidation-warningBackground` / `…warningBorder` | `#352a05` / `#b89500` | **Permission card** |
| `--dl-color-danger-bg` / `-border` | `inputValidation-errorBackground` / `…errorBorder` | `#5a1d1d` / `#be1100` | Reserved; not used by any screen yet (errors are calm, see Callout) |
| `--dl-color-badge-bg` / `-fg` | `badge-background` / `badge-foreground` | `#616161` / `#f8f8f8` | Counts |
| `--dl-color-code-bg` | `textCodeBlock-background` | `#2b2b2b` | Code blocks, inline code, command in permission card |
| `--dl-color-quote-bg` / `-border` | `textBlockQuote-background` / `…border` | `#2b2b2b` / `#616161` | Verbatim quotes |
| `--dl-color-progress` | `progressBar-background` | `#0078d4` | Working progress line |
| `--dl-color-shadow` | `widget-shadow` | `rgba(0,0,0,.36)` | The one floating element (jump pill) |
| `--dl-color-skeleton` | `input-background` | `#313131` | Skeleton blocks |

Dark mode and light mode are not separate token sets: the same token resolves to whatever the theme provides. Reference values for the previews:

| Pair | Dark Modern | Light Modern (preview approx.) |
|---|---|---|
| Primary text on panel | `#cccccc` on `#181818`, 11.6:1 | `#3b3b3b` on `#f8f8f8`, 10.4:1 |
| Secondary text on panel | `#9d9d9d` on `#181818`, 6.9:1 | `#616161` on `#f8f8f8`, 5.9:1 |
| Placeholder on input | `#989898` on `#313131`, 4.5:1 | `#767676` on `#ffffff`, 4.5:1 |
| Button text | `#ffffff` on `#0078d4`, 4.5:1 | `#ffffff` on `#005fb8`, 6.3:1 |
| Text on question card | `#cccccc` on `#063b49`, 7.6:1 | `#3b3b3b` on `#e6f1fb`, 9.8:1 |
| Text on permission card | `#cccccc` on `#352a05`, 8.8:1 | `#3b3b3b` on `#fbf6dd`, 10:1 |

**Colour never carries meaning alone.** Diff counts use `+` and `−` signs (the numbers themselves are secondary text; only the sign is coloured, so the git colours never have to pass text contrast). Authors have an icon *and* a name. Errors have an icon *and* a sentence. Waiting states have an icon *and* the words "Waiting for your answer" or "Waiting for your permission".

Hairline separators (`--dl-color-border` at about 1.4:1 in Dark Modern) are decorative. Controls are identified by their fill, label or the focus ring, not by those borders. In high-contrast themes the borders become strong automatically.

### Typography

| Token | Value | Use |
|---|---|---|
| `--dl-font-family` | `var(--vscode-font-family)` | Everything |
| `--dl-font-family-mono` | `var(--vscode-editor-font-family)` | Code, commands, record and node hashes, diff counts |
| `--dl-font-size-xs` | base − 2 (11px) | Section labels (uppercase), composer hint, tags, badges |
| `--dl-font-size-sm` | base − 1 (12px) | Meta lines (author · grades), file folders, steps, notes |
| `--dl-font-size-base` | `var(--vscode-font-size)` (13px) | Body text: messages, decisions, buttons |
| `--dl-font-size-md` | base + 1 (14px) | Callout titles; **question text** |
| `--dl-font-size-lg` | base + 3 (16px) | Empty-state titles |
| `--dl-font-size-code` | base − 1 (12px) | Code |
| `--dl-line-height-tight` / `-base` / `-code` | 1.3 / 1.5 / 1.45 | Headings / body / code |
| `--dl-font-weight-regular` / `-semibold` | 400 / 600 | Body / names, titles, section labels |
| `--dl-letter-spacing-label` | 0.04em | Uppercase section labels |

Hierarchy comes from size and weight first, then the secondary colour, and only then from accent colours. A decision sentence is base size in primary text; its author and grades are one size down in secondary text; section labels are small, uppercase and secondary, like VS Code's own side bar headers.

### Spacing, radii, lines, sizes, motion

| Group | Tokens |
|---|---|
| Spacing (4px grid) | `--dl-space-2xs` 2 · `xs` 4 · `sm` 8 · `md` 12 · `lg` 16 · `xl` 24 · `2xl` 32 · `3xl` 48 |
| Radii | `--dl-radius-sm` 2 (buttons, inputs, as in VS Code) · `md` 4 (cards, code) · `lg` 6 (user message, composer) · `full` (pills, badges) |
| Lines | `--dl-border-width` 1 · `--dl-border-width-strong` 2 (only the question and permission cards, the answering composer and the quote bar) · `--dl-focus-width` 1 · `--dl-focus-offset` 2 · `--dl-progress-height` 2 |
| Shadow | `--dl-shadow-overlay` (only the floating jump pill; the panel is flat like VS Code) |
| Sizes | `--dl-icon-size` 16 · `--dl-icon-size-lg` 32 · `--dl-control-height` 26 · `--dl-control-height-sm` 22 · `--dl-touch-target` 44 · `--dl-composer-min-height` 40 · `--dl-composer-max-height` 200 · `--dl-content-max-width` 720 |
| Opacity | `--dl-opacity-disabled` 0.4 (VS Code's disabled look) · `--dl-opacity-pulse` 0.5 |
| Motion | `--dl-duration-fast` 100ms · `base` 200ms · `spin` 1000ms · `pulse` 1400ms · `progress` 1600ms |

**Touch targets.** With a mouse, controls use VS Code's own sizes (26px buttons, 22px icon buttons), so the panel feels native. On touch screens (`pointer: coarse`) both tokens become 44px. Every row and every button is a full-size target either way, and nothing relies on hover.

**Reduced motion.** With `prefers-reduced-motion`, spinners, the progress line and skeleton pulses stop. The text beside them ("Editing src/db/client.ts…", "Extracting…") always says what is happening, so nothing is lost.

### Breakpoints (panel width)

The panel's width is the webview's width, so layouts respond to the **panel**, using container queries on `.chat` (`container: panel / inline-size`). Media and container queries can't read CSS variables, so the literal values in CSS must match these tokens:

| Token | Width | What changes |
|---|---|---|
| (below) `--dl-breakpoint-narrow` | < 360px | Padding drops from 16 to 12; the composer hint is hidden (shortcuts still work) |
| `--dl-breakpoint-narrow` | 360px | **Design target.** Permission buttons stack full width; everything is one column |
| `--dl-breakpoint-wide` | ≥ 480px | Permission buttons sit side by side |
| `--dl-breakpoint-xwide` | ≥ 720px | Content and composer centre at `--dl-content-max-width` (720px) so lines stay readable when the panel is dragged wide |

## 3. Focus and keyboard (applies to every component)

- Focus ring: `--dl-focus-width` solid `--dl-color-focus`, offset `--dl-focus-offset` on buttons, inset on inputs and rows. This matches VS Code. It shows on `:focus-visible` only.
- Every control is a real `<button>`, `<textarea>`, `<details>/<summary>` or link, so Tab, Enter and Space work natively.
- Icon-only buttons always have `aria-label` and a matching `title` tooltip.
- Icons are decorative (`aria-hidden`); the text next to them carries the meaning. Author icons get a hidden prefix ("Person: ", "AI: ") so screen readers hear the kind.

## 4. Shared components (`components/ui/`)

These know nothing about chats, decisions or Claude. They take text, icons and callbacks.

### Icon
- **Purpose:** codicon-style 16px line icons. In the webview, use `@vscode/codicons` (the real codicon font, bundled with the extension, so it works offline); the previews use hand-drawn SVG stand-ins.
- **Set used:** `person` (human author), `hubot` (AI author), `git-commit` (decisions, nodes), `diff` (files changed), `file`, `question`, `shield` (permission), `error`, `check`, `loading` (spinner, `~spin`), `debug-stop` (stop), `send`, `arrow-swap` (replaces), `edit`, `terminal`, `search`, `key`, `sign-in`, `link-external`, `copy`, `chevron-right` / `chevron-up`, `arrow-down`, `refresh`, `add`, `ellipsis`, plus the extension's own logo.
- **Variants:** default (inherits text colour), `secondary`, `success`, `warning`, `danger`, `attention`; sizes 16 and 32.
- **Accessibility:** always `aria-hidden`; never the only carrier of meaning.

### Button
- **Purpose:** every action.
- **Variants:** `primary` (the one main action in a context: Send, Allow, Send answer, Check again, Set up a model); `secondary` (other actions: Stop, Deny, Allow for this session, Retry, suggested answers); `text` (link-like, low-weight: Open source, node hash, Hide full reply, Open install guide); `icon` (toolbar-size icon only: Copy, New conversation). Modifier `block` (full width) and `option` (two-line suggested answer: label plus description).
- **Sizes:** one size: `--dl-control-height` (26px, or 44px on touch). Icon buttons use `--dl-control-height-sm`.
- **States:** default · hover (theme hover colour) · focus (ring) · pressed (same as hover; VS Code has no separate pressed style) · disabled (`--dl-opacity-disabled`, `cursor: not-allowed`; use `aria-disabled="true"` instead of `disabled` when the button must still explain itself through a tooltip or nearby text) · loading (`aria-busy="true"`, the leading icon becomes the spinner, and the label becomes a present participle such as "Checking…" or "Retrying…").
- **Rule:** at most one primary button visible per context (the composer, a card, an empty state). Labels are verbs: "Allow", "Retry now", "Set up a model", never "OK" or "Submit".

### RangeSlider
- **Purpose:** pick a whole-number range on a short scale (the grade filter, [filter.md](filter.md)).
- **Anatomy:** label and value on one line; a track with two handles and the selected part filled with `--dl-color-primary`; marks under the track; optional end labels in `--dl-color-fg-secondary`.
- **States:** default · hover (handle takes the primary hover colour) · focus (ring) · disabled (`--dl-opacity-disabled`).
- **Accessibility:** two native range inputs, each with its own label; handles never cross.

### TextArea
- **Purpose:** multi-line text entry (the composer).
- **Variants:** default (bordered); `bare` (no border, inside a container that draws the border and focus ring, as in the composer).
- **Behaviour:** grows with its content from `--dl-composer-min-height` (about 2 lines) to `--dl-composer-max-height` (about 8 lines), then scrolls.
- **States:** empty (placeholder) · focus · filled · disabled (not used by the chat panel; the composer stays editable even when sending is impossible).
- **Accessibility:** always has an accessible name (`aria-label` or `<label>`). The placeholder is never the only label.

### Callout
- **Purpose:** a boxed message with an optional title, body, note and actions.
- **Variants:** `attention` (2px info border, tinted; **only** for a question waiting for the user) · `warning` (2px warning border, tinted; **only** for a permission waiting for the user) · `neutral` (1px border, surface; everything else, including non-blocking errors, whose severity is carried by a danger icon).
- **Parts:** title (icon + text, 14px semibold; 13px in neutral), body, note (secondary, 12px), actions row (wraps; stacks full width under 480px when the consumer asks for it).
- **Accessibility:** the consumer sets the role. Waiting cards are regions with a label; errors use `role="status"`.

### Disclosure
- **Purpose:** show and hide secondary content in place.
- **Built on:** native `<details>/<summary>`, so keyboard and screen-reader support comes for free.
- **Parts:** chevron (rotates 90° when open) and a label that says what will happen: "Why and source" / "Hide why and source", "Show full reply" / "Hide full reply".
- **States:** closed · open · hover (toolbar hover background) · focus.

### Section
- **Purpose:** a titled group inside a response ("Decisions", "Files changed").
- **Parts:** header (icon, uppercase xs label, optional Badge count, optional right-aligned aside such as a total diff count or "Extracting…"), then content.

### Badge
- **Purpose:** a small count (4 decisions, 6 files) and the "waiting" count on the view title. Pill, xs semibold.

### Tag
- **Purpose:** a one-word, outlined label on a row: `new`, `deleted`, `renamed`.

### DiffStat
- **Purpose:** `+added −removed` line counts.
- **Rule:** the numbers are secondary text; only the `+` / `−` signs take the git added/removed colours. A side that is zero is omitted (a new file shows only `+38`).
- **Font:** mono, tabular numbers, so the columns line up.

### ProgressBar
- **Purpose:** an indeterminate 2px line meaning "Claude is working". Sits on the composer's top edge.
- **Accessibility:** `role="progressbar"` with a label. With reduced motion it becomes a static full-width line.

### Skeleton
- **Purpose:** placeholder lines while decisions are extracted. Two lengths: long (decision sentence) and short (meta line).
- **Accessibility:** its container has `aria-busy="true"` and visible text saying what is loading.

### EmptyState
- **Purpose:** whole-panel messages: a new conversation, or Claude Code being unavailable.
- **Variants:** neutral · `danger` (danger-coloured icon, for blocking errors).
- **Parts:** 32px icon, title (16px semibold), body (secondary), optional list, optional code block, actions (one primary).

### Markdown and CodeBlock
- **Purpose:** render Claude's unprocessed reply: paragraphs, lists, inline code, headings and fenced code.
- **CodeBlock parts:** a header with the language and a Copy icon button (label changes to "Copied" for about 2s), then a horizontally scrolling `<pre>`. Code never wraps, so it stays faithful.
- **Rule:** text wraps anywhere when needed (long paths), so the panel never scrolls sideways.

### Quote
- **Purpose:** a verbatim quote: 2px quote-border bar on the left and the quote background. The text is in curly quotes, word for word.

### RowLink
- **Purpose:** a whole row that opens something (a file's diff). Hover background, inset focus ring, full-row target.

## 5. Chat feature components (`features/chat/components/`)

Built from the shared parts above. Specified in detail in [chat-panel.md](chat-panel.md).

| Component | Built from | What it shows |
|---|---|---|
| AuthorLabel | Icon | `person` or `hubot` icon + name; hidden "Person: " / "AI: " prefix |
| UserMessage | (surface box) | Author + the message exactly as typed |
| Response | Section, Callout, Disclosure | One Claude turn, in the fixed order: header/status → question → permission → decisions → files → full reply |
| StatusLine | Icon, spinner | One live line: current action, elapsed time; waiting variant |
| QuestionCard | Callout `attention` / `neutral`, Button `option` | Claude's question in full; suggested answers; after answering, the answer |
| PermissionCard | Callout `warning`, Button | Tool, exact command or file, Claude's reason, Allow / Allow for this session / Deny |
| ResolvedLine | Icon | One quiet line recording a permission decision |
| DecisionList / DecisionItem | Section, Badge, Disclosure, Quote, AuthorLabel | Seq, sentence, author, named grades, replaces, and "Why and source" |
| NodeRef | Button `text` | "Saved as node 3f9a2c1 on main" |
| FilesChanged / FileRow | Section, RowLink, Tag, DiffStat | Each file with counts; one click opens its diff |
| FullReply | Disclosure, Markdown, CodeBlock | The full unprocessed reply, with one line per tool step |
| Composer | TextArea `bare`, Button, ProgressBar | Message box with Send, Stop, answering and blocked variants; jump pill |
