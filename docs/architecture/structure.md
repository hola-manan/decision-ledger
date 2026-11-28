# Folder structure

This is a single VS Code extension, not a backend plus frontend, so the `CLAUDE.md` layout is adapted. Each **module** (feature) is a folder under `src/` with an `index.ts` entry point. The webview mirrors the frontend layout (`components/ui`, `features`, `styles`) inside `src/webview/`. There is no separate `backend/`, because the extension host is the backend.

Moves are kept minimal: existing modules stay where they are, and only the code that must be shared or split moves.

## Target tree

```
decision-ledger/
├── package.json                 # changed: webview view, new commands, scripts, codicons, no chatParticipants
├── tsconfig.json                # changed: excludes the DOM code (src/webview/filter, view, main.ts, bridge.ts)
├── tsconfig.webview.json        # new: DOM lib, ES modules, src/webview + src/protocol → out/browser
├── scripts/
│   └── copy-webview-assets.mjs  # new: copies styles/*.css and @vscode/codicons into out/browser
├── engine/                      # unchanged (fixed contract, separate workspace)
├── docs/
│   ├── architecture/            # these documents
│   └── ui/                      # previews now link ../../src/webview/styles/tokens.css
├── media/icon.svg
├── src/
│   ├── extension.ts             # changed: composition root: creates source, watcher, panel; no registerChat
│   ├── provider.ts              # unchanged (model selection; SecretStorage)
│   ├── render.ts                # changed: imports namedGrades from core
│   ├── cli.ts                   # unchanged
│   ├── chat.ts                  # deleted in the last build step (D-015)
│   ├── core/                    # the ledger module (store, ingest, batching)
│   │   ├── index.ts             # new: public entry point
│   │   ├── grades.ts            # new: namedGrades (moved from render.ts)
│   │   ├── batches.ts           # changed: now defines RawTurn (moved from transcript.ts)
│   │   ├── chunk.ts             # changed: imports RawTurn from ./batches
│   │   ├── store.ts, records.ts, ingest.ts, code.ts, parameters.ts, identity.ts, backoff.ts   # unchanged
│   │   └── transcript.ts        # deleted: split into claude-log/ and watcher/turns.ts
│   ├── claude-log/              # new: the only code that knows Claude Code's JSONL format
│   │   ├── index.ts
│   │   ├── entries.ts           # LogEntry types
│   │   ├── parse.ts             # line → LogEntry; assumptions A2–A14, cited by id
│   │   ├── tools.ts             # tool input/result → facts (paths, counts, questions); no contents leave
│   │   ├── harness.ts           # harness-element stripping (moved from transcript.ts)
│   │   ├── discover.ts          # findSessionFiles, isInsideWorkspace (moved), membership memo; A1
│   │   ├── source.ts            # SessionLogSource: cursors, polling, appends, read() backfill
│   │   └── listeners.ts         # tiny listener/Unsubscribe helper (no vscode)
│   ├── watcher/                 # extraction pipeline (was src/watcher.ts)
│   │   ├── index.ts
│   │   ├── watcher.ts           # AgentWatcher: the VS Code adapter (settings, model, warnings with fixes)
│   │   ├── pipeline.ts          # ExtractionPipeline: subscribes to the source; flush policy; backoff (no vscode)
│   │   ├── turns.ts             # LogEntry → RawTurn (moved from transcript.ts), appendTurns
│   │   ├── status.ts            # ExtractionStatus, ExtractionStatusProvider (no vscode)
│   │   └── offsets.ts           # watch.json read/write: { offset } (no vscode)
│   ├── filter/                  # grade filter above the decisions tree (D-021)
│   │   ├── index.ts
│   │   ├── grade-filter.ts      # ranges: restore, clamp, matchesRanges   (pure)
│   │   ├── filter-view.ts       # FilterViewProvider: webview view, workspaceState (vscode)
│   │   └── html.ts              # HTML shell + CSP + nonce                 (vscode)
│   ├── panel/                   # companion panel, extension side
│   │   ├── index.ts             # registerPanel
│   │   ├── exchanges.ts         # Exchange types + ExchangeBuilder        (pure)
│   │   ├── phase.ts             # phaseOf, endReason                       (pure)
│   │   ├── waiting.ts           # detectWaiting + its constants            (pure)
│   │   ├── files.ts             # collectFileChanges                       (pure)
│   │   ├── activity.ts          # status-line text                         (pure)
│   │   ├── linker.ts            # DecisionLinker                           (no vscode)
│   │   ├── extraction.ts        # sectionState                             (pure)
│   │   ├── view.ts              # → protocol views                         (pure)
│   │   ├── paths.ts             # displayPath: relative to the workspace   (pure)
│   │   ├── errors.ts            # toPanelError: the one error conversion   (pure)
│   │   ├── follower.ts          # SessionFollower                          (no vscode)
│   │   ├── followed-session.ts  # FollowedSession: one session read from its start (no vscode)
│   │   ├── panel-views.ts       # snapshot pieces: exchange, session line, ledger line, badge (pure)
│   │   ├── update-scheduler.ts  # throttled upserts + the quiet wake-up timer, Clock (no vscode)
│   │   ├── session-panel.ts     # SessionPanel orchestrator behind ports   (no vscode)
│   │   ├── actions.ts           # webview action handlers, HostCommands    (no vscode)
│   │   ├── html.ts              # HTML shell + CSP                         (pure; the nonce is passed in)
│   │   └── controller.ts        # PanelController: WebviewViewProvider, badge, HostCommands; registerPanel, ledger.setUpModel (vscode)
│   ├── protocol/                # shared contract; no vscode, no DOM
│   │   ├── index.ts
│   │   ├── filter.ts            # Filter view messages + parseFilterMessage (D-021)
│   │   ├── version.ts           # PROTOCOL_VERSION
│   │   ├── messages.ts          # HostMessage, WebviewMessage unions
│   │   ├── schema.ts            # the small hand-written check combinators (D-013)
│   │   ├── view-checks.ts       # checks per view type, asserted equal to views.ts at compile time
│   │   ├── views.ts             # ExchangeView and friends
│   │   ├── errors.ts            # PanelError, codes, actions
│   │   └── validate.ts          # parseHostMessage, parseWebviewMessage
│   └── webview/                 # runs in the webview (browser); imports use explicit .js extensions
│       ├── filter/              # the Filter view (D-021): main.ts, filter.css
│       ├── main.ts              # entry: bridge + store + render loop
│       ├── bridge.ts            # acquireVsCodeApi, validate inbound, send actions, setState
│       ├── model/               # no DOM; unit-tested in Node
│       │   ├── store.ts         # state + reducer (snapshot, upsert, prepend, action results)
│       │   ├── format.ts        # durations, counts, "Done in 3m 41s"
│       │   ├── copy.ts          # titles/icons per PanelErrorCode, waiting wording
│       │   └── markdown.ts      # safe markdown subset → token tree
│       ├── view/                # DOM
│       │   ├── dom.ts           # element helpers (textContent only)
│       │   ├── states.ts        # loading, problem, empty, session line (step 15)
│       │   ├── exchange-summary.ts  # interim compact exchange; replaced by features/session/ (step 17)
│       │   ├── components/ui/   # Icon, Button, Callout, Disclosure, Section, Tag, DiffStat, Skeleton, EmptyState, Markdown, CodeBlock, Quote, RowLink
│       │   └── features/session/  # SessionLine, Exchange, UserMessage, ResponseHeader, StatusLine, QuestionCard, PermissionCard, DecisionList, NodeRef, FilesChanged, FullReply
│       └── styles/
│           ├── tokens.css       # moved from docs/ui/tokens.css
│           └── panel.css        # component styles (from previews/preview.css, minus composer)
└── test/
    ├── core.test.ts             # changed: transcript tests move out; import paths only
    ├── claude-log.test.ts       # new: parser per assumption, discovery (moved tests), source
    ├── watcher.test.ts          # new: turns projection (moved tests), flush policy, offsets
    ├── panel-exchanges.test.ts  # new: builder, phase, waiting, files, activity
    ├── panel-decisions.test.ts  # new: linker, sectionState
    ├── panel-view.test.ts       # new: view mapping, display paths, toPanelError
    ├── panel-session.test.ts    # new: SessionFollower
    ├── panel-orchestrator.test.ts  # new: SessionPanel + actions with fake ports, a fake clock and a manual source
    ├── panel-html.test.ts       # new: the CSP and HTML shell
    ├── protocol.test.ts         # new: validators accept/reject each message
    ├── webview-model.test.ts    # new: reducer, format, markdown
    ├── boundaries.test.ts       # new: import rules (see below)
    └── fixtures/claude-log/*.jsonl   # new: synthetic fixtures, one per scenario
```

## What belongs in each top-level folder

| Folder | One line |
|---|---|
| `src/core/` | The ledger: storage, record shapes, and the only path to a model (`ingest`). |
| `src/claude-log/` | Reading Claude Code's logs; the only place the JSONL format is known. |
| `src/watcher/` | Turning new log entries into ledger records in the background. |
| `src/panel/` | The companion panel's logic and its VS Code adapter. |
| `src/protocol/` | The typed extension↔webview contract, shared by both sides. |
| `src/webview/` | The panel's UI, running in the webview. |
| `test/` | `node --test` suites; fixtures are synthetic. |
| `scripts/` | Build helpers only. |

## Build and packaging

- `npm run compile` = `tsc -p . && tsc -p tsconfig.webview.json && node scripts/copy-webview-assets.mjs`.
- `npm test` is unchanged in shape: it compiles, then runs `node --test out/test/*.test.js` and the engine tests. `src/webview/model/` and `src/protocol/` are compiled by both configs, so Node can test them.
- The webview loads `out/browser/webview/main.js` as `<script type="module" nonce>`. tsc emits ES modules; no bundler (D-012).
- `vsce package --no-dependencies` doesn't ship `node_modules`, which is why the codicon font and CSS will be copied into `out/browser/codicons/` (when the components need icons, step 17).

## Boundary rules, enforced by `test/boundaries.test.ts`

A small test reads the source files' import lines and fails if:
- a file under `src/` outside a module imports a deep path of `claude-log`, `watcher`, `panel` or `protocol` instead of its `index.ts` (tests may import a module's vscode-free files directly, since an `index.ts` that re-exports a vscode adapter can't load under `node --test`);
- anything under `src/panel/`, `src/protocol/` or `src/webview/` imports `engine` (rule 6: no model path from the panel);
- anything under `src/claude-log/`, `src/protocol/`, `src/webview/model/` or a file marked pure/no-vscode above imports `vscode`;
- `src/webview/` imports anything outside `src/webview/` and `src/protocol/`.

The existing deep imports into `core/` (`./core/store`, `./core/ingest`, …) are migrated to `core/index.ts` when a file is touched, not in a separate sweep.

## Existing files that change

| File | Change |
|---|---|
| `src/core/transcript.ts` | Split: format parsing and discovery → `claude-log/`; `RawTurn` → `core/batches.ts`; the turn projection → `watcher/turns.ts`. Behaviour unchanged; the existing tests move with the code. |
| `src/watcher.ts` | Becomes `src/watcher/watcher.ts`; reads through the source; flushes at turn end; tracks every used chat from 0 (D-020); drops the `importExisting` setting; implements `ExtractionStatusProvider`. |
| `src/render.ts` | `namedGrades` moves to `core/grades.ts`. |
| `src/extension.ts` | Wires the source, watcher and panel; adds `getParent` to the tree provider (needed for `reveal`) plus the commands `ledger.revealNode`, `ledger.setUpModel`, `ledger.chooseSession`, `ledger.followLatestSession`; removes `registerChat`. |
| `src/chat.ts` | Deleted (last step). `splitCode`/`asMarkdownCode`/`isFenced` in `core/code.ts` are deleted with their tests if nothing else uses them. |
| `package.json` | Adds the `ledger.panel` webview view (`"type": "webview"`, name "Live Session") to the `ledger` container, the commands above, the `compile` script and the `@vscode/codicons` devDependency; removes `chatParticipants` and the "Chat" category; updates the welcome text. |
| `tsconfig.json` | Excludes `src/webview/filter/`, `src/webview/view/`, `src/webview/main.ts` and `src/webview/bridge.ts` (DOM code). |
| `docs/ui/tokens.css` | Moved to `src/webview/styles/tokens.css`; the preview links are updated. |
| `README.md` | Describes the companion panel; drops `@ledger`. |

Arrived early with the grade filter (D-021): `tsconfig.webview.json`, `scripts/copy-webview-assets.mjs`, the `tsconfig.json` exclusion of `src/webview/filter/` (DOM code), and the move of `docs/ui/tokens.css` to `src/webview/styles/tokens.css`.
