/**
 * Output 1 — the chat window. @ledger answers like a normal agent, but instead of a long
 * message you get: the code (untouched) + the decision records this turn produced.
 */
import * as vscode from "vscode";
import { randomUUID } from "crypto";
import * as path from "path";
import type { Ledger } from "./core/store";
import { asMarkdownCode, splitCode } from "./core/code";
import { ingest } from "./core/ingest";
import { getEngine, collect } from "./provider";
import { localHumanName } from "./core/identity";
import { cmdLink, recordLine, stateDoc } from "./render";

interface Meta {
  session: string;
  fullText: string;
}

function historyMessages(ctx: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const msgs: vscode.LanguageModelChatMessage[] = [];
  for (const h of ctx.history) {
    if (h instanceof vscode.ChatRequestTurn) msgs.push(vscode.LanguageModelChatMessage.User(h.prompt));
    else if (h instanceof vscode.ChatResponseTurn) {
      const full = (h.result.metadata as Meta | undefined)?.fullText;
      if (full) msgs.push(vscode.LanguageModelChatMessage.Assistant(full));
    }
  }
  return msgs;
}

function sessionOf(ctx: vscode.ChatContext): string {
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const h = ctx.history[i];
    if (h instanceof vscode.ChatResponseTurn) {
      const s = (h.result.metadata as Meta | undefined)?.session;
      if (s) return s;
    }
  }
  return randomUUID();
}

const trusted = (s: string) => {
  const m = new vscode.MarkdownString(s);
  m.isTrusted = { enabledCommands: ["ledger.openRecord", "ledger.showText", "ledger.showState"] };
  return m;
};

const AGENT_SYSTEM =
  "You are a coding agent working in the user's VS Code workspace. Be direct. Put all code in fenced code blocks. " +
  "State clearly any decision you make (approach, library, structure, trade-off) and why — it will be recorded.";

export function registerChat(ctx: vscode.ExtensionContext, getLedger: () => Ledger, onChange: () => void) {
  let humanName: string | undefined; // looked up once: it runs git, which blocks
  const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
    const ledger = getLedger();
    const session = sessionOf(chatCtx);

    if (request.command === "state") {
      const head = ledger.head();
      stream.markdown(trusted(head ? stateDoc(ledger, head) : "_No decisions recorded yet._"));
      return { metadata: { session, fullText: "" } };
    }
    if (request.command === "log") {
      const log = ledger.log(undefined, 20);
      stream.markdown(
        trusted(
          log.length
            ? log.map((l) => `- \`${l.hash.slice(0, 7)}\` ${l.node.message} (+${l.node.added.length}) · ${l.node.origin} · ${cmdLink("ledger.showState", "state", l.hash)}`).join("\n")
            : "_No nodes yet._"
        )
      );
      return { metadata: { session, fullText: "" } };
    }

    // 1. Let the model do the work, but don't show its prose.
    stream.progress("Working…");
    const messages = [
      vscode.LanguageModelChatMessage.User(AGENT_SYSTEM),
      ...historyMessages(chatCtx),
      vscode.LanguageModelChatMessage.User(request.prompt),
    ];
    const resp = await request.model.sendRequest(messages, {}, token);
    const fullText = await collect(resp, token);
    if (token.isCancellationRequested) return { metadata: { session, fullText } };

    // 2. Code passes straight through.
    const code = splitCode(fullText).filter((s) => s.kind === "code");
    for (const c of code) stream.markdown(asMarkdownCode(c.text) + "\n");

    // 3. Everything else becomes decision records.
    stream.progress("Recording decisions…");
    try {
      const engine = await getEngine(ctx, request.model);
      const result = await ingest(
        ledger,
        [
          { author: "human", text: request.prompt },
          { author: "ai", name: request.model.id, text: fullText },
        ],
        engine,
        { origin: "vscode-chat", session, humanName: (humanName ??= localHumanName(path.dirname(ledger.dir))) }
      );
      if (result) {
        const recs = ledger.records(result.records);
        stream.markdown(
          trusted(
            `\n**Decisions** · node \`${result.node.slice(0, 7)}\`\n\n` +
              recs.map((r) => "- " + recordLine(ledger, r.hash, r.record)).join("\n")
          )
        );
        onChange();
      } else {
        stream.markdown(trusted("\n_No new decisions this turn._"));
      }
    } catch (e: any) {
      stream.markdown(trusted(`\n⚠️ Couldn't record decisions: ${e?.message ?? e}`));
    }
    stream.markdown(trusted("\n\n" + cmdLink("ledger.showText", "Show full reply", fullText)));
    return { metadata: { session, fullText } satisfies Meta };
  };

  const participant = vscode.chat.createChatParticipant("decision-ledger.ledger", handler);
  participant.iconPath = new vscode.ThemeIcon("git-commit");
  ctx.subscriptions.push(participant);
}
