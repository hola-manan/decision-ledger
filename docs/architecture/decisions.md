# Decision log

Newest at the bottom. D-001 records the stack as it already is; the rest belong to the companion panel.

## D-001: Keep the existing stack
Context: The extension is TypeScript on the VS Code API, compiled by plain `tsc`, tested with `node --test`, with the engine as an npm workspace. There is no project `CLAUDE.md` recording this.
Decision: Keep all of it. Add nothing to the extension's runtime dependencies. The only new dev dependency is `@vscode/codicons` (D-012).
Alternatives: A bundler (esbuild/webpack), a test framework (vitest/jest). Neither is needed for what's planned.
Consequences: The stack should also be written into a project `CLAUDE.md` (open question for the founder).

## D-002: Companion panel instead of a chat panel built on the Agent SDK
Context: The plan was a Decision Ledger chat panel running Claude Code through the Claude Agent SDK. Anthropic's policy doesn't allow third-party products to use a person's claude.ai subscription login without approval, and the branding rules get in the way of a product that looks like Claude Code.
Decision: The panel has no input. The user keeps typing in the official Claude Code extension; Decision Ledger follows that session by reading the JSONL log Claude Code already writes. It never starts, drives, signs in to or answers for Claude.
Alternatives: Agent SDK with an API key (changes who pays and isn't the user's real Claude Code); a CLI wrapper with streaming JSON (the same login problem); approval from Anthropic (slow and uncertain).
Consequences: No Send, Stop, Allow or answer controls. Permission and question cards are read-only. Live text arrives a block at a time. The design depends on an undocumented log format (D-004).

## D-003: One log source feeds both the watcher and the panel
Context: The watcher already tails the session logs. The panel needs the same lines, sooner and from the start of the session.
Decision: `claude-log`'s `SessionLogSource` is the only reader. It holds one byte cursor per file, parses each line once, and emits batches to subscribers. Subscribers backfill with a synchronous `read(file, from)` through the same parser, which gives no gap or overlap with later appends.
Alternatives: The panel reads files itself (two parsers drift apart and double the IO); the watcher hands its turns to the panel (turns have already lost the tool calls, stop reasons and code that the panel shows).
Consequences: The watcher stops opening files. A file found after the source starts is read from 0, which fixes today's gap where a new session's first prompt (written before the first poll) was skipped.

## D-004: Isolate every Claude Code format assumption in one parser
Context: The JSONL format isn't documented and can change with any Claude Code release.
Decision: Only `claude-log/parse.ts` (plus `tools.ts`, `harness.ts` and `discover.ts`) reads raw JSON. Each assumption (A1–A14 in data-model.md) is cited by id in the code and has a synthetic fixture test. Other modules see only `LogEntry`. The parser reports drift (many lines, nothing recognised) as `LOG_FORMAT_UNRECOGNIZED`.
Alternatives: Parse where needed (the format leaks everywhere); depend on an official SDK type package (none exists for the log).
Consequences: A format change is fixed in one folder. File contents and tool output are reduced to counts there, so they can't leak further by accident.

## D-005: Poll, fast for the followed file
Context: The panel should feel live. `fs.watch` is unreliable on Windows and in OneDrive-synced folders, and the watcher already polls.
Decision: Discovery and other files are polled at `ledger.agents.pollSeconds` (5 s). The followed file is stat-ed every `LIVE_POLL_MS` (750 ms) and read only when it has grown.
Alternatives: `fs.watch` or `vscode.workspace.createFileSystemWatcher` outside the workspace (unreliable, platform-specific); uniform fast polling (wasteful across many sessions).
Consequences: `ledger.agents.pollSeconds` and `ledger.agents.claudeProjectsDir` are read when the extension starts; changing them takes a window reload. Up to about 1 s of latency in the panel. A new session is noticed within about 5 s. Discovery memoises "is this file in the workspace", because the head-scan of unmatched folders was being repeated on every poll.

## D-006: An exchange is one human prompt up to the next
Context: The panel shows "exchanges", and the log is a flat list of lines.
Decision: An exchange starts at a `PromptEntry` (the same human-prompt rule the watcher uses for human turns) and contains everything up to the next one. Its id is the prompt's uuid, which also equals the human turn's `externalId` in the ledger.
Alternatives: Group by assistant `message.id` (splits one reply into many); by turn end (an interrupted or crashed reply never ends).
Consequences: Stable ids across reloads with nothing stored. Harness-only user lines never start an exchange.

## D-007: Detect "waiting" from the log, with a stated confidence
Context: Without driving Claude Code, the panel only sees the log. A pending tool call looks the same whether the tool is running or Claude Code is asking for permission.
Decision: Three signals. A pending `AskUserQuestion` is a **certain** question. An ended reply whose final paragraph ends with `?` is a **likely** question. Any other pending call, after 3 s of quiet, for a tool that can ask, outside `bypassPermissions` (and outside `acceptEdits` for edits), is a **possible** permission wait. The badge shows only for certain and likely waits. The status line says "Waiting for you in Claude Code" (certain/likely) or "Claude Code may be waiting for your permission" (possible).
Alternatives: Read Claude Code's settings files to predict allow rules (fragile and private to Claude Code); badge every pending tool (a long `npm test` would raise a false alarm every time).
Consequences: Permission detection has false positives (long commands) and false negatives (prompts under 3 s). The founder's rule that a false alarm costs less than a miss is applied to questions, not to permissions.

## D-008: Files changed from edit tools only; paths and counts, no diffs
Context: The UI wants files changed with +/- counts and a diff per file. Rule 6 allows local display, but every extra copy of code is a risk.
Decision: File rows come from successful Edit, MultiEdit, Write and NotebookEdit calls: the path, added or modified, and line counts from `toolUseResult.structuredPatch` or Write's create/update, falling back to counting the tool input. Bash never adds rows, because the log can't say which files a command touched. A row opens the file. No diffs in v1.
Alternatives: `git diff` snapshots per exchange (mixes in the person's own edits and needs git); rebuilding before/after from patches (fragile once later edits overlap).
Consequences: Deletions, renames and changes made through Bash aren't shown. Counts are unknown for notebooks. Code content stops at the parser.

## D-009: Link decisions to exchanges through the turn's `externalId`, on the current branch
Context: Records are grounded to turn hashes; the panel groups by exchange.
Decision: record → `ledger.turn(source.turn)` → (`session`, `externalId`) → the exchange containing that entry uuid. The node is found by indexing `added` along `ledger.log()` from HEAD. Only records in the current branch's state are shown. Immutable objects are memoised by hash.
Alternatives: Store an exchange id on records (changes the record shape, which is fixed); match by timestamps (ambiguous).
Consequences: Decisions on other branches don't show in the panel (like the tree). Records from `vscode-chat`/`cli` origins have no exchange and appear only in the tree.

## D-010: Extraction progress comes from the watcher's committed offset
Context: The panel must show "Extracting…", "N decisions" or an error per exchange, and survive reloads without a cache.
Decision: The watcher exposes `ExtractionStatus` per file (committed offset, in-flight range, last failure and next retry). An exchange is done when its end offset ≤ the committed offset. `watch.json` keeps its shape.
Alternatives: Persist per-exchange status (a second source of truth that can disagree with the ledger); infer from records alone (can't tell "0 decisions" from "not processed yet").
Consequences: After a reload, status is right as soon as `watch.json` is read; failures reappear on the next attempt.

## D-011: The watcher also flushes when a turn ends
Context: The watcher waits for 20 s of quiet before extracting, so "Extracting…" would sit there long after a reply finished.
Decision: Flush a file's backlog when an entry passes `isTurnEnd`, as well as on idle and on reaching 24 turns.
Alternatives: Lower `idleSeconds` (extracts mid-run more often and splits exchanges across batches).
Consequences: Decisions usually appear a few seconds after the reply ends. Mid-turn waits (a question) still flush on idle.

## D-012: No webview framework and no bundler
Context: The panel is one screen of mostly static content with a few disclosures. The design system already defines plain CSS components.
Decision: Plain TypeScript building DOM with `textContent`, a small reducer, and re-rendering of the changed exchange only. tsc emits ES modules that the webview loads with `type="module"`. Markdown is a small safe subset parser (paragraphs, headings, lists, emphasis, inline code, fenced code, links). Codicons ship as the official font, copied from `@vscode/codicons`.
Alternatives: React/Preact or Lit (a runtime plus a bundler, for a screen this size); markdown-it (needs bundling or vendoring, and its HTML output must be sanitised); VS Code's internal `markdown.api.render` (undocumented output, needs sanitising).
Consequences: About 150 lines of markdown code to own and test. If the UI grows into many interactive screens, revisit with Preact.

## D-013: A versioned, validated protocol of whole-exchange upserts
Context: The webview is a separate program; messages cross a trust boundary in both directions.
Decision: Every message is `{ v, type, … }`, validated on receipt by hand-written validators in `src/protocol/` (the engine's `schemas.ts` style). Updates replace a whole `ExchangeView`, throttled to 250 ms per exchange. The first message after `ready` is a full snapshot.
Alternatives: JSON-patch diffs (smaller but harder to keep correct); a schema library (a new dependency for about 15 message types).
Consequences: A long exchange is re-sent whole on each update. That's acceptable locally; patches can be added later without a version bump, as a new message type.

## D-014: Follow the newest prompt; let the person pin a session
Context: Several Claude Code sessions can be active in one workspace, and the person can start or switch conversations at any time.
Decision: In auto mode the panel follows the session that most recently received a **human prompt**. On first open it follows the most recently modified session. "Switch session" pins one; "Follow latest" unpins. The choice is saved in `workspaceState`.
Alternatives: Follow the most recently modified file (flaps between two sessions that are both working); always ask (friction).
Consequences: Typing in another session moves the panel there, which matches where the person's attention is. Background agent activity doesn't steal the panel.

## D-015: Remove the legacy `@ledger` chat participant
Context: VS Code 1.146 deprecated chat participants. The companion panel replaces the participant's visible job, showing decisions per exchange. The tree's commands cover `/state` and `/log`.
Decision: Delete `src/chat.ts`, its `chatParticipants` contribution and the "Chat" category as the last build step, once the panel works. Keep `ledger ingest` (CLI) for manual input. Records with origin `vscode-chat` stay readable.
Alternatives: Keep it behind a setting (dead code on a deprecated API); replace it now with an MCP server or tools (not needed for this feature).
Consequences: Anyone who uses `@ledger` loses it; the product is pre-1.0. A future "ask the ledger" feature would be a new design (open question).

## D-016: Leave room for "save a missed sentence as a decision"
Context: The founder deferred this. It needs grading without extraction, which the engine doesn't offer.
Decision: Reserve the protocol message `saveDecision` (rejected in v1). Propose an additive engine function `gradeDecision(input, model) → Grades` for the engine developer. The record shape stays the same; "Saved by" lives on the node's message and origin (`manual`).
Alternatives: Save ungraded records (breaks the expectation that every record is graded against a parameter set); have the panel call a model directly (breaks "only core calls a model").
Consequences: No code now. The engine developer gets a clear, backward-compatible request.

## D-017: Rebuild from the log and the ledger on every reload; no cache
Context: Panels and windows reload, and webview views are destroyed when hidden.
Decision: On `ready`, the host reads the followed file from 0 through the source, rebuilds exchanges, links records and sends a snapshot of the latest 30 exchanges; earlier ones come on request. The webview keeps only UI state in `setState`. `retainContextWhenHidden` stays off.
Alternatives: Cache exchanges in `.ledger/` or `globalStorage` (a second copy of conversation text, including code, on disk; can go stale).
Consequences: Reopening a very long session costs one full read and parse, measured in tens of milliseconds for typical files. If profiling shows otherwise, index offsets per exchange in memory, still without a disk cache.

## D-018: The panel never reaches a model
Context: Rule 6: code never reaches a model. The panel displays code (the full reply) locally.
Decision: Only `core/ingest.ts` (and the future `saveDecision`) calls the engine. `panel/`, `protocol/` and `webview/` may not import `engine`; `test/boundaries.test.ts` enforces this. The panel makes no network requests, and the webview's CSP forbids remote origins.
Alternatives: Trust review alone (rules decay).
Consequences: Any future panel feature that needs a model goes through core, where code is stripped.

## D-019: camelCase everywhere
Context: Existing TypeScript and the ledger's JSON use camelCase.
Decision: Protocol fields, view types and new meta fields use camelCase.
Alternatives: snake_case for the wire format (inconsistent with every existing file).
Consequences: Claude Code's snake_case fields (`tool_use_id`, `stop_reason`) are renamed inside the parser and nowhere else.

## D-020: A chat the extension is used on is processed from its first message
Context: The founder's rule: exchanges from before watching began are always processed once the extension is used on that chat. A "skipped" state would leave holes in the ledger.
Decision: A session is *used* when it gets new lines while the extension runs, or when the panel follows it. On first use the watcher tracks the file from offset 0 and extracts its whole history through the existing backlog batching (`ingestBacklog`), oldest first, before newer turns. The source's cursor still starts at the file size for append events; the watcher backfills with `read(file, 0, cursor)`. The `ledger.agents.importExisting` setting is removed: it's now always on for used chats.
Alternatives: Skip pre-watch exchanges (the founder ruled it out); process every session in the workspace at activation (sends dormant chats nobody opened to the model, at real cost).
Consequences: The first use of a long, old chat sends its full history to the model once, in batches; the panel shows "Extracting…" on those exchanges meanwhile. Sessions nobody uses are never processed. Entries already in `watch.json` from before this change keep their offsets.

## D-021: A grade filter above the decisions tree, view-only
Context: The founder wants to narrow the decisions view by grade, with a two-handle slider per parameter like a shop's price filter. VS Code's tree view can't hold custom controls.
Decision: A small webview view, `ledger.filter` ("Filter"), sits above the `ledger.tree` view in the Decision Ledger sidebar. It shows one two-handle slider per parameter in `.ledger/config.json`, snapping to whole grades from `GRADE_MIN` to `GRADE_MAX`. A record is shown only if its grade fits every narrowed slider; a record with no grade for a narrowed parameter is hidden. Nodes with no shown record are hidden while the filter is narrowed. Order is never changed. The ranges are saved per workspace in `workspaceState`; a filter icon on the tree's title bar shows or hides the strip. Nothing outside the view changes: extraction, storage and the CLI ignore the filter.
Alternatives: Turn the whole tree into a webview (rebuilds keyboard, theming and accessibility the native tree gives for free); filter through quick-pick menus (cheap, but not a slider).
Consequences: The first webview ships before the panel, so the webview build pieces planned for the panel (`tsconfig.webview.json`, `scripts/copy-webview-assets.mjs`, `src/webview/styles/tokens.css`) arrive now. The filter's message types live in `src/protocol/filter.ts`.
