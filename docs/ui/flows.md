# Flows: chat panel

There is only one screen (the chat panel, [chat-panel.md](chat-panel.md)). The flows below move between its states. State numbers match the preview's switcher; clicking the controls named here in [`previews/chat-panel.html`](previews/chat-panel.html) follows the same arrows.

## 1. Send a message and read the result

```mermaid
flowchart TD
  S0{Claude Code ready?} -- not installed --> E13[13 · Not installed]
  S0 -- not signed in --> E14[14 · Not signed in]
  E13 -- Check again --> S1
  E14 -- Sign in in a terminal, then Check again --> S1
  S0 -- yes --> S1[1 · Empty panel]
  S1 -- Send --> S3[3 · Working]
  S3 -- Claude needs permission --> S2[2 · Permission prompt]
  S2 -- Allow / Allow for session / Deny --> S3
  S3 -- Claude asks --> S4[4 · Question]
  S4 -- suggested answer / Send answer --> S3
  S3 -- Stop or Esc --> S9[9 · Stopped]
  S3 -- Claude Code error --> S10[10 · Turn failed]
  S10 -- Try again --> S3
  S3 -- turn ends --> S5[5 · Decisions extracting]
  S9 --> S5
  S5 -- decisions found --> S6[6 · Processed]
  S5 -- none found --> S8[8 · No decisions]
  S5 -- API / bad reply --> S11[11 · Extraction failed]
  S5 -- no model --> S12[12 · No model]
  S11 -- Retry now / automatic retry --> S5
  S12 -- Set up a model, then Retry --> S5
  S6 -- Show full reply --> S7[7 · Full reply expanded]
  S7 -- Hide full reply --> S6
  S6 -- Send next message --> S3
  S8 -- Send next message --> S3
```

## 2. Check a decision against its source

```mermaid
flowchart LR
  D[Decision in a response] -- Why and source --> W[Rationale, verbatim quote, grade scales]
  W -- Open source --> R[Record view in an editor tab: full source message]
  D -- node hash --> T[Node revealed in the Decision Ledger sidebar]
```

## 3. Find something the engine missed

```mermaid
flowchart LR
  A[Any response] -- Show full reply --> B[Full unprocessed reply inline]
  B -- Hide full reply, top or bottom --> A
  X[Extraction failed] -- opens automatically --> B
```

## 4. Review what changed

```mermaid
flowchart LR
  F[Files changed row] -- click --> G[VS Code diff: before this turn vs after]
```
