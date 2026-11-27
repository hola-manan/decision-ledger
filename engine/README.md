# Decision Ledger engine

Conversation in, grounded decisions out.

Decision Ledger turns human↔AI coding chats into an ordered, versioned log of decisions. This package is the part that reads a stretch of conversation and says which decisions were made, by whom, where, and how each one grades on the parameters the project owner chose. It knows nothing about VS Code, storage or transcripts. It takes plain JSON and returns plain JSON, with a language model plugged in.

## Quick start

```sh
npm install                 # from the repo root (npm workspaces) or from engine/
npm test                    # offline: no network, no key needed
GEMINI_API_KEY=... npm run extract -- examples/conversation.json
```

`npm run extract` reads an input file (or stdin) and prints the result. For the model it uses `ANTHROPIC_API_KEY` if set, otherwise `GEMINI_API_KEY`. The Gemini key must be a Vertex AI express-mode key; AI Studio keys get a 401/403. `LEDGER_MODEL` overrides the default model (`claude-haiku-5-5` or `gemini-3.8-flash`).

## The contract

The types live in [src/contract.ts](src/contract.ts). That file and this section must agree.

### Input: `ExtractionInput`

```jsonc
{
  "parameters": [                  // what to grade each decision on, chosen by the project owner (may be [])
    { "id": "reversibility", "name": "Reversibility", "low": "practically irreversible", "high": "trivial to undo" }
  ],
  "turns": [                       // the new part of the conversation, oldest first
    { "id": "t1", "author": { "kind": "human", "name": "Priya" }, "text": "No passwords, magic links only." },
    { "id": "t2", "author": { "kind": "ai", "name": "claude-opus-5-5" }, "text": "I'll expire links after 15 minutes.\n[code omitted]" }
  ],
  "activeDecisions": [             // decisions already in force, oldest first (may be [])
    { "id": "d1", "author": { "kind": "ai", "name": "claude-opus-5-5" }, "decision": "Store users in MongoDB." }
  ]
}
```

| Field | Rules |
|---|---|
| `parameters[].id` | A letter, then letters, digits or underscores; unique. It's the key in `grades`. |
| `parameters[]` | `name`, `low` (what a grade of 1 means) and `high` (what 5 means) are non-empty text. The model only grades; it never adds or changes parameters. |
| `turns[].id` | Any non-empty string. Ids may repeat (the extension uses content hashes, so identical messages share one); each decision gets the id of the turn it names. The engine never shows ids to the model. |
| `turns[].author` | `{ kind, name }`: `kind` is `"human"` or `"ai"`; `name` is the person's name or the model's name. A project can have many people. |
| `turns[].text` | **Must already be code-free.** The caller replaces every piece of code with `[code omitted]` (`CODE_PLACEHOLDER`). The engine doesn't detect code; `parseExtractionInput` only rejects text with a fenced code block (```` ``` ```` or `~~~`), as a last line of defence. |
| `activeDecisions[].id` | Any non-empty string, unique within the call. |
| `activeDecisions[]` | `author` as for turns; `decision` is non-empty text. |

`parseExtractionInput(value)` checks untrusted JSON (such as files given to `npm run extract`) against these rules. It throws `InvalidInputError` naming the bad field (e.g. `turns[0].author.kind: expected "human" or "ai"`) and drops unknown fields. `parseParameterDefinitions(value, where)` checks a parameter list on its own, e.g. one loaded from a config file.

### Output: `ExtractedDecision[]`

```jsonc
[
  {
    "decision": "Store users in Postgres instead of MongoDB.",
    "turnId": "t3",
    "author": { "kind": "human", "name": "Sam" },
    "grades": { "codeSpan": 4, "reversibility": 2 },
    "rationale": "Postgres is already running for billing.",   // optional
    "quote": "store users in Postgres, not Mongo.",           // optional
    "supersedes": "d1"                                         // optional
  }
]
```

### Guarantees

Each of these is enforced in code ([src/parse.ts](src/parse.ts); 7 in [src/extract.ts](src/extract.ts)) and has a test in [test/extract.test.ts](test/extract.test.ts). Nothing the model says is trusted as is.

1. `turnId` is always one of the input turn ids.
2. `author` always equals that turn's author (kind and name), whatever the model claims.
3. `grades` only has keys from the input `parameters`, and every value is a whole number from 1 to 5 (`GRADE_MIN`–`GRADE_MAX`). A grade the model leaves out or gets wrong is absent; the decision is kept. With no parameters, `grades` is `{}`.
4. `quote`, if present, appears in that turn's text, ignoring case and runs of whitespace; it is the model's wording of it. A quote that can't be found, or that is just `[code omitted]`, is dropped; the decision is kept.
5. `supersedes`, if present, is always the id of an active decision the model was shown (the latest 40). Any other reference is dropped, so a made-up number can't retire an old decision.
6. `decision` is non-empty and trimmed; empty or malformed items from the model are skipped.
7. Turns that are only `[code omitted]` are not sent. If no turns are left, the model isn't called and the result is `[]`.
8. Decisions come back in the order the model gave them. The caller assigns the final order when it stores them.

### Errors

| Error | When |
|---|---|
| `InvalidInputError` | `parseExtractionInput` got input that breaks the contract. |
| `ModelOutputError` | The reply was unusable: not JSON (prose or a code fence around the JSON is fine), JSON without a decisions list, or no text at all (e.g. blocked). The message is fixed per cause; the raw reply is on `.reply`, because it contains conversation text and shouldn't be logged casually. |
| `ApiError` (`provider`, `status`) | A provider's HTTP API failed. The message never contains the key. |
| `NoModelError` | `modelFromEnv` found no key. |

Errors are thrown, never swallowed; retrying is the caller's job. A reply of `{"decisions": []}` means "no decisions"; anything else that isn't a decisions list is an error.

### The model

```ts
type Model = (system: string, user: string) => Promise<string>;
```

Any function with this shape works: `anthropicModel(key, name)`, `geminiModel(key, name)`, `modelFromEnv()`, a VS Code Copilot adapter (in the extension's `src/provider.ts`), or a fake in tests.

## How it works

1. [prompt.ts](src/prompt.ts) builds the prompt: the parameters with their 1 and 5 meanings, the active decisions, then the turns with each author's kind and name. Turns are labelled `1, 2, …` and active decisions `#1, #2, …` by position, so caller ids stay out of the prompt and can't be confused with each other. Only the latest 40 active decisions are sent.
2. The model replies with `{"decisions":[{decision, rationale, turn, author, quote, grades, supersedes}]}`.
3. [parse.ts](src/parse.ts) reads the reply, maps the labels back to caller ids, and enforces the guarantees above.

## Layout

```
engine/
├── src/
│   ├── index.ts        public API: import only from here
│   ├── contract.ts     input/output types, CODE_PLACEHOLDER, Model
│   ├── extract.ts      extractDecisions(input, model)
│   ├── prompt.ts       system prompt + prompt builder
│   ├── parse.ts        reply → guaranteed output
│   ├── schemas.ts      parseExtractionInput for untrusted JSON
│   ├── errors.ts
│   ├── config.ts       modelFromEnv (the only place env vars are read)
│   ├── models/         anthropic.ts, gemini.ts
│   └── run.ts          the `npm run extract` command
├── test/               extract, schemas, models; all offline
└── examples/conversation.json
```

## How the extension uses it

The extension calls `extractDecisions` from one place, `src/core/ingest.ts`. Before that call it has already:

- stripped code from every turn and stored the turns,
- when watching agent sessions only: split long messages into pieces of at most 4,000 characters and grouped turns into batches of at most 24. The chat participant and `ledger ingest` send whole messages in one call, so input size is not bounded.

It passes the ledger's active decisions, using record hashes as ids, and the parameters from `.ledger/config.json`, which the project owner edits. Human names come from the project's git `user.name` (else the OS login); AI names are the model names in the chat log. Every decision the engine returns is stored as one record in a new node, together with a reference to the parameter set it was graded against. Changing the engine never requires touching the extension, as long as the contract holds.

## Open work (yours)

- **Recall is low.** A live session gave 1 decision from 7 turns. The system prompt says "Be conservative", which is the likeliest cause. There is no evaluation set yet; building one (conversations with the decisions a human expects) is the first step before tuning.
- **Fallback grounding is a guess.** If the model names a turn that doesn't exist, the decision is attached to the first turn by the same author, or else the last turn. It may be better to drop it.
- **What counts as a decision** is still an open product question. The current definition is in the system prompt.
- **Only the latest 40 active decisions** are shown to the model, so older ones can never be marked as replaced.
- **Grades are unchecked for quality.** The engine guarantees their shape (known parameters, 1–5), not that they're sensible. The evaluation set should cover grades too.
- **A bad reply blocks its batch.** The extension retries a batch that gets a `ModelOutputError` with backoff, but the same conversation may keep producing the same bad reply.
