/**
 * Groups one session's log entries into exchanges: a prompt the person typed, plus
 * everything until their next prompt (data-model.md §2, invariants in §6). Pure: no
 * vscode, no clock.
 */
import type { AssistantEntry, LogEntry, PromptEntry, ToolCall, ToolResultEntry } from "../claude-log";

export interface Exchange {
  /** The prompt entry's uuid (stable across reloads, equal to the human Turn's externalId), or "line:<offset>" without one. */
  id: string;
  sessionId: string;
  prompt: { text: string; timestamp: string; permissionMode?: string };
  /** Every entry uuid in the exchange, for linking ledger records to it. */
  entryIds: Set<string>;
  /** Start of the prompt line. */
  startOffset: number;
  /** End of the last entry so far. */
  endOffset: number;
  /** The first assistant model seen. */
  model?: string;
  /** Text and tool steps, in log order. */
  parts: ReplyPart[];
  /** By tool_use id. */
  calls: Map<string, CallState>;
  lastAssistant?: AssistantEntry;
  interrupted: boolean;
  /** A later prompt started another exchange. */
  isReplaced: boolean;
  /** Timestamp of the last entry; "" until one has a timestamp. */
  lastEntryAt: string;
}

/** A prompt line without a uuid (A4 says there always is one) gets an id from its position. */
const NO_UUID_PREFIX = "line:";

export type ReplyPart = { type: "text"; text: string } | { type: "step"; callId: string };

export interface CallState {
  call: ToolCall;
  /** The tool_use line's timestamp; may be "". */
  at: string;
  result?: ToolResultEntry;
}

/**
 * Batches must come in byte-offset order, each line's entries in one batch (the source
 * only emits whole lines). After the log shrinks and is read again from the start, use a
 * new builder.
 */
export class ExchangeBuilder {
  private readonly list: Exchange[] = [];
  private readonly byId = new Map<string, Exchange>();
  private readonly byEntry = new Map<string, Exchange>();
  private appliedThroughOffset = 0;
  /** Set after a repeated prompt: its entries are history already shown. */
  private isSkippingRepeat = false;
  private orphans = 0;

  constructor(private readonly sessionId: string) {}

  /**
   * Applies entries and returns the ids of the exchanges that changed. Entries ending at
   * or before the offset reached when this call began were applied already and are
   * ignored; entries of one line share offsets, so the threshold is fixed per call.
   */
  apply(entries: readonly LogEntry[]): string[] {
    const seenThrough = this.appliedThroughOffset;
    const changed = new Set<string>();
    for (const entry of entries) {
      if (entry.endOffset <= seenThrough) continue;
      this.appliedThroughOffset = Math.max(this.appliedThroughOffset, entry.endOffset);
      const exchange = this.applyEntry(entry);
      if (exchange) changed.add(exchange.id);
    }
    return [...changed];
  }

  exchanges(): readonly Exchange[] {
    return this.list;
  }

  exchangeOfEntry(uuid: string): Exchange | undefined {
    return this.byEntry.get(uuid);
  }

  /** Tool results with no matching call in their exchange; reported as format drift. */
  get orphanResults(): number {
    return this.orphans;
  }

  private applyEntry(entry: LogEntry): Exchange | undefined {
    if (entry.kind === "prompt") return this.startExchange(entry);
    const current = this.list.at(-1);
    if (!current || this.isSkippingRepeat) return undefined; // before the first prompt, or repeated history
    switch (entry.kind) {
      case "assistant":
        addAssistant(current, entry);
        break;
      case "toolResult":
        if (!addResult(current, entry)) {
          this.orphans++;
          return undefined;
        }
        break;
      case "interrupt":
        current.interrupted = true;
        break;
    }
    this.include(current, entry);
    return current;
  }

  private startExchange(prompt: PromptEntry): Exchange | undefined {
    const id = prompt.uuid || `${NO_UUID_PREFIX}${prompt.startOffset}`;
    this.isSkippingRepeat = this.byId.has(id);
    if (this.isSkippingRepeat) return undefined; // A13: a resumed session can repeat earlier history
    const previous = this.list.at(-1);
    if (previous) previous.isReplaced = true;
    const exchange: Exchange = {
      id,
      sessionId: this.sessionId,
      prompt: { text: prompt.text, timestamp: prompt.timestamp, ...(prompt.permissionMode ? { permissionMode: prompt.permissionMode } : {}) },
      entryIds: new Set(),
      startOffset: prompt.startOffset,
      endOffset: prompt.endOffset,
      parts: [],
      calls: new Map(),
      interrupted: false,
      isReplaced: false,
      lastEntryAt: "",
    };
    this.list.push(exchange);
    this.byId.set(exchange.id, exchange);
    this.include(exchange, prompt);
    return exchange;
  }

  /**
   * An entry uuid belongs to one exchange. Only a prompt takes one over: an interrupt and
   * the next prompt can share a line, and the uuid then means the new exchange.
   */
  private include(exchange: Exchange, entry: LogEntry): void {
    if (entry.uuid) {
      const owner = this.byEntry.get(entry.uuid);
      if (owner && owner !== exchange && entry.kind === "prompt") {
        owner.entryIds.delete(entry.uuid);
        owner.endOffset = Math.min(owner.endOffset, entry.startOffset); // the shared line now opens the new exchange
      }
      if (!owner || entry.kind === "prompt") {
        exchange.entryIds.add(entry.uuid);
        this.byEntry.set(entry.uuid, exchange);
      }
    }
    exchange.endOffset = entry.endOffset;
    if (entry.timestamp) exchange.lastEntryAt = entry.timestamp;
  }
}

function addAssistant(exchange: Exchange, entry: AssistantEntry): void {
  exchange.model ??= entry.model;
  exchange.lastAssistant = entry;
  for (const block of entry.blocks) {
    if (block.type === "text") exchange.parts.push({ type: "text", text: block.text });
    if (block.type === "toolUse" && !exchange.calls.has(block.call.id)) {
      exchange.calls.set(block.call.id, { call: block.call, at: entry.timestamp });
      exchange.parts.push({ type: "step", callId: block.call.id });
    }
  }
}

/** The reply's last text that isn't blank, if any. */
export function lastTextPart(exchange: Exchange): string | undefined {
  for (let i = exchange.parts.length - 1; i >= 0; i--) {
    const part = exchange.parts[i];
    if (part.type === "text" && part.text.trim()) return part.text;
  }
  return undefined;
}

/** Invariant 4: a result attaches only to a call in the same exchange. False for an orphan. */
function addResult(exchange: Exchange, entry: ToolResultEntry): boolean {
  const state = exchange.calls.get(entry.toolUseId);
  if (!state) return false;
  state.result = entry;
  return true;
}
