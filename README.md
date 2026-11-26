# Decision Ledger

Your AI agent writes code and a lot of words around it. The code goes straight through. The words are turned into **decisions**. Each decision is linked back to the chat turn that produced it (human or AI) and stored as an **ordered record** in a **git-style tree**, where every node is a snapshot of the database's state.

## Three places it shows up

| Where | What you get |
|---|---|
| **Chat window** | `@ledger` in VS Code Chat. You get the code blocks as-is, plus the decision records that turn produced, instead of a long message. The full reply is one click away. |
| **Backend** | `.ledger/` in your project, a content-addressed store (turns → records → nodes), plus a `ledger` CLI any agent or script can read from and write to. |
| **Autonomous agents** | Claude Code sessions in this workspace are tailed automatically. Each batch of the agent's activity becomes a node of ordered decisions instead of a long trace. |

## Install

```
code --install-extension decision-ledger-0.1.0.vsix
```

You need a model for extraction. You can use either:
- **GitHub Copilot Chat** (used automatically through VS Code's language model API), or
- an Anthropic key: run **Ledger: Set Anthropic API Key**. It's stored in VS Code's secret storage. The default model is `claude-haiku-5-5`, or
- a Gemini key for Vertex AI express mode: run **Ledger: Set Vertex AI (Gemini) API Key**. Also stored in secret storage. The default model is `gemini-3.8-flash` (`ledger.engine.geminiModel`).

With `ledger.engine.provider` on `auto`, an Anthropic key wins, then a Gemini key, then Copilot.

## Use it

- **Chat:** open the Chat view and type `@ledger add rate limiting to the login route`. You can also use `@ledger /state` and `@ledger /log`.
- **Sidebar:** the Decision Ledger icon shows nodes (newest first). Expand a node to see its records. Click a record to open its source: the decision, who brought it, the grounding quote and the full source turn.
- **Right-click a node:** *Show State at Node*, *Diff with Parent*, *Create Branch Here*.
- **Agents:** just run Claude Code in the workspace. New turns are processed once the agent has been idle for 20s (configurable). Old sessions are skipped unless `ledger.agents.importExisting` is on.

## Data model

```
turn    { author: human|ai, text (code stripped), session, origin }
record  { seq, decision, rationale?, author, turn → hash, quote?, supersedes? → record }
node    { parent → node, message, origin, added: [record], state: [every record, in order] }
```

- **Ordered:** `seq` increases along a branch's history.
- **Grounded:** every record points to a stored turn. A quote is kept only if it appears word for word in that turn.
- **Tree:** nodes chain through `parent`. Branches live in `refs/heads/`, and `HEAD` works just like it does in git.
- **Superseded:** a later decision can replace an earlier one. Both stay in history, and only the newer one is *active*.
- **No code:** fenced code blocks and file-writing tool inputs are never sent to the extraction model. Unfenced code (e.g. a paste with no ```) is detected on a best-effort basis: runs of 3+ code-like lines, including diffs, HTML/XML and SQL, are removed too. Snippets of one or two lines, YAML and plain shell commands can still get through, so fence code you paste if it must not leave your machine.

Commit `.ledger/` with your repo if you want the decision history to travel with the code.

## CLI

```
npx ledger log | state [node] | show <hash> | diff <a> <b> | branch [name [at]] | checkout <ref>
echo '[{"author":"human","text":"..."},{"author":"ai","text":"..."}]' \
  | ANTHROPIC_API_KEY=... npx ledger ingest --origin my-agent --session run-42
```
`ingest` uses `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` (Vertex AI express mode) if that's the only one set. `LEDGER_MODEL` overrides the model.

## Develop

```
npm install && npm test      # core tests
npm run package              # builds the .vsix
```
Press F5 in VS Code to run it in an Extension Development Host.
