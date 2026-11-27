# Screen: Chat panel

Preview: [`previews/chat-panel.html`](previews/chat-panel.html) (every state below is in its state switcher; start from [`previews/index.html`](previews/index.html)).
Tokens and components: [design-system.md](design-system.md). Flows: [flows.md](flows.md).

## Purpose and primary action

The extension's own chat panel, a webview view in the side bar (usually 300–500px wide). The user types to Claude Code; the real Claude Code runs underneath exactly as it does in the terminal (same agent, tools, project and account). Only what is **shown** changes: each reply is processed into what matters, and the full reply is always one click away.

**Primary action:** send a message (the composer's **Send** button). While Claude is waiting for the user, the primary action becomes **answering** (Send answer, or Allow on a permission card).

## What is never hidden, and why

| Never hidden | Why |
|---|---|
| **Claude's questions**, in full, word for word | Claude is blocked until the user answers. A summary could change the meaning of the question. After it's answered, the question stays in full, styled calmly, with the answer under it. |
| **Permission prompts**, with the exact command or file | The user is approving a real action on their machine, so they must see exactly what will run. After the decision, one line records it ("Allowed Bash: npm install … · by Priya, this time only"). |
| **The full, unprocessed reply**, one click away on every response | The extraction engine still misses decisions (recall is low; see `engine/README.md`). Nothing Claude said may be lost. When extraction fails, the full reply **opens by itself**. |
| **What Claude did before a stop or a crash** | Partial work is still real work: its files, its decisions and its full reply are kept. |
| **The user's draft** | Text in the composer survives errors, stops, setup problems and panel reloads. |

Loud styling (tinted background, 2px border) is reserved for a question or permission prompt **that is waiting**. Nothing else in the panel is allowed to shout. Errors that don't block the user are calm boxes with a danger icon.

## Data shown

There is no `docs/architecture/api.md` yet. This is what the panel needs, and where it comes from today:

| Element | Data | Source |
|---|---|---|
| User message | text; author `{ kind: human, name }` | Composer; name from git `user.name` (else OS login), as `src/core/identity.ts` does today |
| Response header | model name, elapsed time, end reason (done / stopped by you / error) | Claude Code session event stream |
| Status line | current activity (tool + target, thinking, writing) | Claude Code event stream (tool-use events) |
| Question card | full question text; suggested answers (label + description) if Claude offered them | Claude Code's ask-the-user tool event, or the final text of the turn (see open question 1) |
| Permission card | tool name, exact command / file path / URL, Claude's stated reason if any, session-rule scope | Claude Code permission request |
| Decisions | per record: `seq`, `decision`, `author {kind,name}`, `grades {parameterId: 1–5}` with each parameter's `name`, `low`, `high` from the record's `parameterSet`, `rationale?`, `source.quote?`, `supersedes?` (its seq, sentence and author); node hash and branch | `ExtractedDecision[]` from the engine, then the stored records and node in `.ledger/` |
| Extraction state | pending / done / failed + error kind (`NoModelError`, `ApiError {provider, status}`, `ModelOutputError`) | `src/core/ingest.ts` |
| Files changed | path, change kind (added / modified / deleted / renamed), lines added and removed, before/after for the diff | Claude Code edit and write events, or `git diff` against the state before the turn. Computed locally; **code never leaves the machine**, as now |
| Full reply | the turn's assistant text (markdown) and its tool steps in order (tool, target, short outcome) | Claude Code session transcript |

Gaps that need an architecture decision (not founder questions): (a) how the panel drives Claude Code (SDK or CLI with a streaming JSON protocol) and receives permission requests; (b) how "files changed" is computed per turn (tool events vs. git snapshot). The design works with either.

## Layout

Narrow first (360px). Top to bottom:

```
┌ DECISION LEDGER: CHAT       (1)  [+] [⋯] ┐  ← VS Code view title (badge only while Claude waits)
│                                           │
│ ┌───────────────────────────────────────┐ │
│ │ 👤 Priya                               │ │  UserMessage (raised surface)
│ │ Sam wants users in Postgres so we're   │ │
│ │ on one database with billing. Switch…  │ │
│ └───────────────────────────────────────┘ │
│                                           │
│ 🤖 claude-opus-5-5 · Done in 3m 41s       │  Response header
│                                           │
│ ┌ ? Claude asked ────────────────────────┐│  1. Question (in full; loud only while waiting)
│ │ While moving users to Postgres I found ││
│ │ 14 accounts … Which email should win?  ││
│ │ ✓ Priya answered: Keep both. …         ││
│ └────────────────────────────────────────┘│
│ ✓ Allowed Bash: npm install prisma … ·    │  2. Permission (resolved line)
│   by Priya, this time only                │
│                                           │
│ ◦ DECISIONS (4)                           │  3. Decisions
│ #15 Store users in Postgres instead of    │
│     MongoDB.                              │
│     👤 Priya · Code span 4/5 ·            │
│     Reversibility 2/5                     │
│     ⇄ Replaces #9: Store users in         │
│       MongoDB. (Sam)                      │
│     › Why and source                      │
│ ───────────────────────────────────────── │
│ #16 Use Prisma as the Postgres client.    │
│     🤖 claude-opus-5-5 · Code span 3/5 ·  │
│     Reversibility 3/5                     │
│     › Why and source                      │
│ …                                         │
│ ◦ Saved as node 3f9a2c1 on main           │
│                                           │
│ ▤ FILES CHANGED (6)          +161 −99     │  4. Files changed
│ 📄 schema.prisma  prisma   [new]   +38    │
│ 📄 client.ts      src/db       +21 −34    │
│ …                                         │
│                                           │
│ ┌ › Show full reply   as Claude wrote it ┐│  5. Full reply (collapsed)
│ └────────────────────────────────────────┘│
├───────────────────────────────────────────┤
│ ┌───────────────────────────────────────┐ │  Composer (fixed at the bottom)
│ │ Ask Claude to change something…        │ │
│ │ Enter to send · Shift+Enter…  [➤ Send]│ │
│ └───────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

- The **transcript** scrolls; the **composer** is fixed at the bottom. New content auto-scrolls to the bottom only if the user is already at the bottom; otherwise their scroll position is kept.
- Spacing: 32px between exchanges, 16px between the parts of a response, 8px inside a section. No horizontal rules between exchanges; the raised user message is the anchor for the eye.
- **Wider panels:** at ≥ 480px the permission buttons sit in one row. At ≥ 720px the transcript and composer centre at 720px. At < 360px, padding drops to 12px and the composer hint hides.
- **Phone width:** the same single-column layout; on touch, controls grow to 44px.

### Response anatomy (fixed order, always)

1. **Header**: AI author (hubot icon + model name) · end state ("Done in 3m 41s", "Stopped by you after 0:41", "Stopped by an error after 0:22"). While working, the header says "Working" and the **StatusLine** sits below it.
2. **Question** (if any)
3. **Permission** (waiting card, or resolved lines)
4. **Decisions** (always present once the turn has ended: loading, list, empty or error)
5. **Files changed** (present only if at least one file changed; during the turn: "Files changed so far")
6. **Full reply** (always present once Claude has said anything)

The order never changes between states, so the user learns where to look.

## Components used

Shared: Button (primary, secondary, text, icon, option), TextArea (bare), Callout (attention, warning, neutral), Disclosure, Section, Badge, Tag, DiffStat, ProgressBar, Skeleton, EmptyState (neutral, danger), Markdown, CodeBlock, Quote, RowLink, Icon.
Chat feature: AuthorLabel, UserMessage, Response, StatusLine, QuestionCard, PermissionCard, ResolvedLine, DecisionList/DecisionItem, NodeRef, FilesChanged/FileRow, FullReply, Composer.

## States

Numbers match the preview's state switcher.

### 1 · Empty: new conversation
- EmptyState, vertically centred: ledger logo, **"Chat with Claude Code"**, then: "This is the Claude Code you already use, working in this project. Its replies are shown as what matters:"
  - "Questions and permission requests, always in full"
  - "The decisions made, who made them, and their grades"
  - "The files changed, one click from each diff"
  - "The full reply, one click away"
- Footer meta: "Decisions are saved to the ledger on branch **main**." (the current branch).
- Composer focused, placeholder "Ask Claude to change something…".

### 2 · Needs you: permission prompt
- Header shows the model only; the StatusLine is in its **waiting** variant (shield icon, "Waiting for your permission", elapsed time; no spinner).
- PermissionCard (warning callout): title **"Allow Bash?"** (the tool's name: "Allow edit?", "Allow web fetch?"…); "Claude wants to run this command in **signup-service**:"; the exact command in a code box (wraps, never truncated); "Claude's reason: …" if Claude gave one.
- Buttons: **Allow** (primary) · **Allow `npm install` for this session** (secondary) · **Deny** (secondary). They stack full width under 480px.
- For file edits: "Claude wants to edit `docker-compose.yml` (+9 −11)." plus a "Show the change" text button that opens the diff; the session button reads "Allow all edits for this session".
- Composer: no progress line (Claude is paused); placeholder "Claude is waiting for your permission above."; **Stop** button.
- The view title shows a badge (1).

### 3 · Claude working
- Header: model · "Working". StatusLine: spinner, one line describing the current action, elapsed time (m:ss). It updates in place; it never becomes a log.
- Resolved permission lines from earlier in the turn stay visible.
- "Files changed so far" grows as files change.
- Composer: 2px progress line on its top edge; placeholder "Draft your next message…"; **Stop** (secondary) replaces Send; hint "Esc to stop". The draft is kept and can be sent when the turn ends.

**Status wording** (one line, ellipsis at the end if too long; the full text is in a tooltip):

| Claude Code activity | Status text |
|---|---|
| Thinking | Thinking… |
| Read a file | Reading src/users/userRepository.ts… |
| Edit a file / write a new file | Editing src/db/client.ts… / Creating prisma/schema.prisma… |
| Run a command | Running npm test… (Claude's short description of the command if it gave one, else the command itself) |
| Search code / find files | Searching for "sendEmail"… / Finding files matching *.test.ts… |
| Fetch a web page | Fetching docs.example.dev… |
| Run a sub-agent | Running a sub-agent: review the migration… |
| Write the final text | Writing the reply… |

### 4 · Needs you: Claude asks a question
- StatusLine waiting variant: question icon, "Waiting for your answer".
- QuestionCard (attention callout): title **"Claude is asking you"**; the question **in full**, rendered markdown, one size up (14px). Never truncated, never summarised.
- If Claude offered answers: one two-line option button per answer (label + description), stacked. Then the note "Or type a different answer below."
- Composer switches to **answering**: label "Answering Claude's question" above it, 2px attention border, placeholder "Type your answer…", button **Send answer**. It is focused automatically (on a desktop pointer only, so a phone keyboard doesn't pop open).
- The view title badge shows (1). If the user has scrolled up, a **jump pill** ("Claude is asking you", with a down arrow) floats above the composer and scrolls to the card.

### 5 · Reply done, decisions still extracting
- Header: "Done in 3m 41s". Question (answered), permission lines, files and the collapsed full reply are all there already.
- Decisions section: header "Decisions" with a spinner and "Extracting…" on the right; two skeleton rows; "Finding the decisions in this reply. This usually takes a few seconds." `aria-busy="true"`.
- Composer is idle: the user can send the next message right away; extraction carries on.

### 6 · Processed reply (success)
- Everything in the fixed order. Decisions list each **DecisionItem**:
  - `#15` (record seq, mono, secondary), the decision sentence (primary text);
  - meta line: author icon + name · one item per grade, "**Code span 4/5** · **Reversibility 2/5**", using the parameter names the record was graded against (an ungraded record shows only the author);
  - if it supersedes something: "⇄ Replaces #9: Store users in MongoDB. (Sam)";
  - Disclosure **"Why and source"** (just "Source" when there's no rationale). It reveals: **Why** (rationale), **Quote · {author}** (the verbatim quote), **Grades** (each grade with its scale: "1 = touches a single line or function · 5 = touches the whole codebase"), and **Open source**.
- Under the list: "Saved as node `3f9a2c1` on main". The hash is a text button.
- FilesChanged: header with count and total `+161 −99`; one RowLink per file: icon, file name, folder (secondary, truncates first), tag (`new`, `deleted`, `renamed`), counts. Files are listed in the order Claude first touched them.
- Full reply collapsed: "Show full reply", with "as Claude wrote it" on the right.

### 7 · Full reply expanded
- The full-reply toggle reads "Hide full reply". Below it, in a bordered surface box: Claude's text as rendered markdown, interleaved with one quiet line per tool step ("Read `src/users/userRepository.ts`", "Ran `npm install …` · allowed by Priya", "Asked which email should win · Priya answered "Keep both"", "Ran `npm test` · 41 passed"), and fenced code as CodeBlocks with Copy.
- A second **Hide full reply** button at the bottom; it collapses the reply and scrolls the toggle back into view, so a long reply never strands the user.
- Note for review: the sample's last paragraph ("I left the Mongo service in `docker-compose.yml`, commented out…") is a decision the engine missed. That is exactly why this exists.

### 8 · Reply with no decisions (empty)
- Decisions section: header "Decisions (0)", then "No decisions in this reply." and in secondary text "Extraction can miss some. Everything Claude said is in the full reply."
- Files changed and the full reply as usual.

### 9 · Stopped by you
- Header: "Stopped by you after 0:41". Decisions are extracted from what was said up to the stop (here 1). Files changed shows what was written. The full reply ends with the step "Stopped by Priya".

### 10 · Error: Claude Code stopped mid-reply
- Header: "Stopped by an error after 0:22". Below it, a neutral callout with a danger icon: **"Claude Code stopped with an error"**, the error as Claude Code reported it ("API Error: 500 Internal server error."), note "What Claude did before the error is kept below.", button **Try again** (sends the same message again).
- Decisions, files and the full reply for the partial turn follow as usual.

### 11 · Error: extraction failed (API or bad model reply)
- Decisions section holds a neutral callout with a danger icon: **"Couldn't extract decisions"**.
  - `ApiError` 429/5xx: "The Anthropic API is overloaded (529). Trying again in 20 seconds." Retries automatically with backoff (3 tries), then stops and says "Retry when you're ready."
  - `ApiError` 401/403: "The Anthropic API rejected the key (401)." Button: Set up a model. No automatic retry.
  - `ModelOutputError`: "The model's reply couldn't be read. Retry usually fixes this."
- Note: "The reply is saved and shown in full below, so nothing is missed." Button **Retry now** (secondary).
- **The full reply opens by itself** in this state; the user can collapse it.

### 12 · Error: no model for extraction (`NoModelError`)
- Same place and shape: key icon, **"No model to extract decisions"**, "Decision Ledger needs a model to find decisions: GitHub Copilot Chat, an Anthropic API key, or a Vertex AI (Gemini) key." Note: "The reply is saved and shown in full below. Its decisions are extracted once a model is set up."
- Buttons: **Set up a model** (primary; opens a quick pick of the three existing setup commands) · **Retry**. The full reply opens by itself.
- After setup, every reply still waiting for extraction is processed, oldest first.

### 13 · Error: Claude Code not installed
- Replaces the empty panel: EmptyState (danger): **"Claude Code isn't installed"**, "This panel runs Claude Code on your machine, so it needs the `claude` command. Install it, then check again.", the install command in a CodeBlock with Copy, **Check again** (primary), **Open install guide** (text, external link).
- Composer stays editable and keeps any draft; Send is disabled with the hint "Your message is kept until Claude Code is ready."
- If this happens mid-conversation, the transcript stays and the same content appears as a neutral callout at the end of it.

### 14 · Error: Claude Code not signed in
- EmptyState (neutral, sign-in icon): **"Sign in to Claude Code"**, "Claude Code is installed but not signed in. Sign in once in a terminal; this panel uses the same account." **Sign in in a terminal** (primary; opens a VS Code terminal running `claude`) · **Check again**. Meta: "Opens a VS Code terminal running `claude`. Follow its sign-in steps, then come back."
- The composer works as in state 13 (the preview shows a kept draft).

### 15 · A conversation (3 exchanges)
- Magic-link signup (3 decisions, 4 files) → Mongo to Postgres (answered question, a permission line, 4 decisions incl. one that replaces an older one, 6 files) → fixing tests (no decisions, 2 files). Opens scrolled to the bottom; scroll up to judge the rhythm.

## Interactions

| Control | Does | Notes |
|---|---|---|
| Composer, Enter | Sends | Shift+Enter adds a new line. Empty or whitespace-only text doesn't send (nothing happens; no error message). |
| Send | Sends the message; the transcript scrolls to it; the composer clears and switches to running | The text is kept until Claude Code accepts it; if sending fails, it goes back into the composer. |
| Stop / Esc | Stops the turn (like Esc in Claude Code). No confirmation: stopping loses nothing | The partial turn is processed as state 9. |
| Allow | Approves this one request; the card collapses to a resolved line; Claude continues | |
| Allow … for this session | Approves this and matching requests until the panel's Claude Code session ends | The button names the scope: "Allow `npm install` for this session", "Allow all edits for this session". |
| Deny | Refuses; the card collapses to "Denied …"; Claude is told and carries on without it | To redirect Claude, Stop and send a new message. |
| Suggested answer | Sends that answer; the card turns calm ("Claude asked" + "Priya answered: …") | |
| Send answer | Sends the typed answer, same result | |
| Jump pill | Scrolls to the waiting card and focuses its first button (or the composer, for a question) | Appears only when the waiting card is out of view. |
| Why and source | Toggles the decision's details in place | |
| Open source | Opens the existing record view (`ledger.openRecord`) in an editor tab: decision, author, grades with scales, quote, full source message | Same view the sidebar uses today. |
| Node hash | Reveals that node in the Decision Ledger sidebar tree | |
| File row | Opens VS Code's diff editor: the file before this turn ↔ after this turn | Deleted files open the old content; new files open against empty. |
| Show / Hide full reply | Expands or collapses the reply inline | The bottom Hide button also scrolls the toggle back into view. |
| Copy (code block) | Copies the code; the label becomes "Copied" for about 2 seconds | |
| Retry now / Retry | Re-runs extraction for this reply; the section returns to the loading state | |
| Set up a model | Quick pick: Use GitHub Copilot Chat · Set Anthropic API key · Set Vertex AI (Gemini) key | Existing commands. |
| Try again (turn error) | Sends the same user message again as a new turn | |
| Check again | Re-checks for Claude Code; on success the panel shows state 1 with the draft kept | Button shows "Checking…" while busy. |
| View title [+] | New conversation | No confirmation: the old conversation's decisions are already in the ledger and the transcript stays in Claude Code's session history. |
| View title badge | Shows (1) while a question or permission is waiting, so it's visible even when the panel is hidden | Uses the webview view badge. |

## Accessibility

- The StatusLine is a polite live region, throttled to one announcement every 5 seconds. "Waiting for your answer/permission" is announced at once.
- A waiting QuestionCard or PermissionCard is a labelled region; when it appears, it is announced. Focus moves to the composer (question) and is **not** moved onto Allow (permission), so a stray Enter can't approve a command.
- Author kind is spoken ("Person: Priya", "AI: claude-opus-5-5"). Grades are text ("Code span 4/5"), not pips.
- Every control is reachable by Tab in reading order: card actions, then decision disclosures, file rows, the full-reply toggle, and the composer.
- The Decisions section has `aria-busy` while extracting.

## Copy reference

| Where | Text |
|---|---|
| Empty title | Chat with Claude Code |
| Composer placeholder (idle / running / waiting / answering) | Ask Claude to change something… / Draft your next message… / Claude is waiting for your permission above. / Type your answer… |
| Composer hints | Enter to send · Shift+Enter for a new line / Esc to stop / Enter to send · Esc to stop / Your message is kept until Claude Code is ready. |
| Header end states | Working / Done in 3m 41s / Stopped by you after 0:41 / Stopped by an error after 0:22 |
| Waiting status | Waiting for your answer / Waiting for your permission |
| Question | Claude is asking you / Or type a different answer below. / Claude asked / {Name} answered: … |
| Permission | Allow {Tool}? / Claude wants to run this command in {project}: / Claude's reason: … / Allow / Allow {scope} for this session / Deny |
| Resolved | Allowed {Tool}: {target} · by {Name}, this time only / … for this session / Denied {Tool}: {target} · by {Name} |
| Decisions | Decisions / Extracting… / Finding the decisions in this reply. This usually takes a few seconds. / No decisions in this reply. / Extraction can miss some. Everything Claude said is in the full reply. / Why and source / Source / Open source / Replaces #{seq}: {decision} ({author}) / Saved as node {hash} on {branch} |
| Files | Files changed / Files changed so far / new / deleted / renamed |
| Full reply | Show full reply / Hide full reply / as Claude wrote it |
| Errors | see states 10–14 |

## Open questions for the founder

1. **Plain-text questions.** Claude often asks in its closing sentence instead of using its ask-the-user tool ("Want me to write the migration script next?"). Should the panel treat any reply whose final paragraph contains a question as a QuestionCard? **Recommendation: yes.** Show that final paragraph in full as a question; a false positive only shows a bit more text, while a miss hides a question.
2. **Scope of "Allow for this session".** Per command prefix (`npm install` …) like Claude Code's own rules, or per tool (all Bash)? **Recommendation: command prefix for Bash, whole tool for edits**, with the scope written on the button.
3. **Missed decisions.** The full reply exists because extraction misses things. Should the user be able to select a sentence in the full reply and record it as a decision ("Record as decision")? It isn't designed here: it needs a way to create a record without the engine.

## Founder decisions, 2026-11-27

These settle the open questions above and add one behaviour. The previews show each one.

1. **Questions asked in plain text get the full question card.** When Claude ends a reply with a question in prose instead of using its ask-the-user tool ("Want me to add a test for…?"), the panel lifts that question into the same attention card, in full, with the composer switched to answering. A false alarm costs a little attention; a missed question costs a turn. Detecting these is the panel's job, not the engine's. Preview: state 9.
2. **"Allow for this session" names its scope on the button.** For shell commands the scope is the command prefix (`Allow npm install … for this session`, covering every command that starts with `npm install` until a new conversation); for file edits it is the whole tool (`Allow all file edits for this session`). Preview: state 2.
3. **Later, not in the first build:** a sentence the engine missed can be saved as a decision. Selecting text in the expanded full reply offers *Save as decision*. The saved record is credited to whoever wrote the sentence (here claude-opus-5-5), grounded in that message with the selection as its quote, marked "Saved by <person> from the full reply", and committed as its own node. Grading it needs a grade-only call to the engine, which the engine does not have yet: a gap for the architect. Previews: states 7 and 8.
4. **Claude's words stream in while it works.** Under the live status line, Claude's text arrives as written, unprocessed (a quiet left rule and a caret). When the turn ends, the stream is replaced by the processed reply, and the full text moves behind *Show full reply*. Under reduced motion the caret does not blink; with scripting off the whole text shows. Preview: state 3.

## Hallmark polish, 2026-11-27

The layout and the VS Code theme mapping stayed; the polish fixed what read as generated or broken:

- Section and detail labels are sentence case in the body face, no longer tracked capitals.
- Meta rows (author, grades, timing) separate their parts with space and a hairline instead of middle dots.
- Counts are part of a heading's words ("4 decisions", "6 files changed") instead of a badge inside it.
- Controls are 32px tall; the focus ring is 2px and lifted toward the text colour so it holds 3:1 on raised surfaces; field edges are mixed from the secondary text colour so they hold 3:1 in every theme.
- The suggested-answer buttons align left; button labels never wrap; the panel never scrolls sideways.
- Typographic quotes and apostrophes throughout.
