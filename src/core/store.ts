/**
 * Decision Ledger store: a git-style, content-addressed tree of decision records.
 *
 *   .ledger/
 *     HEAD                  "ref: refs/heads/main" or a node hash (detached)
 *     refs/heads/<branch>   node hash
 *     objects/ab/cdef...    JSON objects: turn | record | node
 *
 * - turn   : one chat message (human or ai) with code stripped. Records are grounded to it.
 * - record : one decision. Ordered by `seq` (monotonic along a branch's history).
 * - node   : a snapshot of the database state, like a git commit. Points at its parent,
 *            lists the records it added, and the full ordered state after it.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export type Author = "human" | "ai";

export interface Turn {
  type: "turn";
  author: Author;
  text: string;
  session: string;
  origin: string; // e.g. "vscode-chat", "claude-code"
  externalId?: string;
  timestamp: string;
}

export interface DecisionRecord {
  type: "record";
  seq: number;
  decision: string;
  rationale?: string;
  author: Author;
  turn: string; // hash of the Turn it was brought by
  quote?: string; // verbatim excerpt from that turn
  supersedes?: string; // hash of an earlier record this one replaces
  timestamp: string;
}

export interface LedgerNode {
  type: "node";
  parent: string | null;
  message: string;
  origin: string;
  session?: string;
  added: string[]; // record hashes added in this node, in order
  state: string[]; // every record hash in the db at this node, in order
  timestamp: string;
}

export type LedgerObject = Turn | DecisionRecord | LedgerNode;

export interface NewDecision {
  decision: string;
  rationale?: string;
  author: Author;
  turn: string;
  quote?: string;
  supersedes?: string;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

export function hashObject(obj: LedgerObject): string {
  return createHash("sha1").update(canonical(obj)).digest("hex");
}

export class Ledger {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static open(root: string): Ledger {
    const dir = path.join(root, ".ledger");
    fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
    fs.mkdirSync(path.join(dir, "refs", "heads"), { recursive: true });
    const head = path.join(dir, "HEAD");
    if (!fs.existsSync(head)) fs.writeFileSync(head, "ref: refs/heads/main\n");
    return new Ledger(dir);
  }

  // ---------- objects ----------

  put(obj: LedgerObject): string {
    const h = hashObject(obj);
    const p = this.objPath(h);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + ".tmp" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, p);
    }
    return h;
  }

  get<T extends LedgerObject>(hash: string): T {
    return JSON.parse(fs.readFileSync(this.objPath(this.resolve(hash)), "utf8")) as T;
  }

  /** Accepts full hashes or unique prefixes (min 4 chars). */
  resolve(ref: string): string {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    if (/^[0-9a-f]{4,39}$/.test(ref)) {
      const d = path.join(this.dir, "objects", ref.slice(0, 2));
      const hits = fs.existsSync(d)
        ? fs.readdirSync(d).filter((f) => (ref.slice(0, 2) + f).startsWith(ref))
        : [];
      if (hits.length === 1) return ref.slice(0, 2) + hits[0];
      throw new Error(hits.length ? `Ambiguous ref ${ref}` : `Unknown ref ${ref}`);
    }
    const b = this.branchHead(ref);
    if (b) return b;
    throw new Error(`Unknown ref ${ref}`);
  }

  private objPath(h: string): string {
    return path.join(this.dir, "objects", h.slice(0, 2), h.slice(2));
  }

  // ---------- refs ----------

  currentBranch(): string | null {
    const head = fs.readFileSync(path.join(this.dir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  }

  branchHead(name: string): string | null {
    const p = path.join(this.dir, "refs", "heads", name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() || null : null;
  }

  head(): string | null {
    const raw = fs.readFileSync(path.join(this.dir, "HEAD"), "utf8").trim();
    if (raw.startsWith("ref: ")) return this.branchHead(raw.slice("ref: refs/heads/".length));
    return raw || null;
  }

  branches(): { name: string; head: string | null; current: boolean }[] {
    const cur = this.currentBranch();
    const dir = path.join(this.dir, "refs", "heads");
    const names = fs.readdirSync(dir);
    if (cur && !names.includes(cur)) names.push(cur);
    return names.sort().map((name) => ({ name, head: this.branchHead(name), current: name === cur }));
  }

  createBranch(name: string, at?: string): void {
    if (!/^[\w./-]+$/.test(name)) throw new Error(`Invalid branch name ${name}`);
    if (this.branchHead(name)) throw new Error(`Branch ${name} already exists`);
    const target = at ? this.resolve(at) : this.head();
    fs.writeFileSync(path.join(this.dir, "refs", "heads", name), (target ?? "") + "\n");
  }

  checkout(ref: string): void {
    if (fs.existsSync(path.join(this.dir, "refs", "heads", ref))) {
      fs.writeFileSync(path.join(this.dir, "HEAD"), `ref: refs/heads/${ref}\n`);
    } else {
      fs.writeFileSync(path.join(this.dir, "HEAD"), this.resolve(ref) + "\n");
    }
  }

  private moveHead(to: string): void {
    const br = this.currentBranch();
    const p = br ? path.join(this.dir, "refs", "heads", br) : path.join(this.dir, "HEAD");
    fs.writeFileSync(p, to + "\n");
  }

  // ---------- writing ----------

  addTurn(t: Omit<Turn, "type">): string {
    return this.put({ type: "turn", ...t });
  }

  /**
   * Append decisions as a new node on top of HEAD. Records get the next `seq`
   * numbers, so order is always preserved. Returns null if nothing was added.
   */
  commit(
    decisions: NewDecision[],
    meta: { message: string; origin: string; session?: string }
  ): { node: string; records: string[] } | null {
    if (!decisions.length) return null;
    const parent = this.head();
    const prevState = parent ? this.get<LedgerNode>(parent).state : [];
    let seq = prevState.length ? this.get<DecisionRecord>(prevState[prevState.length - 1]).seq : 0;
    const now = new Date().toISOString();
    const added = decisions.map((d) =>
      this.put({
        type: "record",
        seq: ++seq,
        decision: d.decision.trim(),
        rationale: d.rationale?.trim() || undefined,
        author: d.author,
        turn: d.turn,
        quote: d.quote,
        supersedes: d.supersedes,
        timestamp: now,
      })
    );
    const node = this.put({
      type: "node",
      parent,
      message: meta.message,
      origin: meta.origin,
      session: meta.session,
      added,
      state: [...prevState, ...added],
      timestamp: now,
    });
    this.moveHead(node);
    return { node, records: added };
  }

  // ---------- reading ----------

  log(from?: string, limit = 200): { hash: string; node: LedgerNode }[] {
    const out: { hash: string; node: LedgerNode }[] = [];
    let h: string | null = from ? this.resolve(from) : this.head();
    while (h && out.length < limit) {
      const node = this.get<LedgerNode>(h);
      out.push({ hash: h, node });
      h = node.parent;
    }
    return out;
  }

  records(hashes: string[]): { hash: string; record: DecisionRecord }[] {
    return hashes.map((hash) => ({ hash, record: this.get<DecisionRecord>(hash) }));
  }

  /** All records at a node, in order. */
  stateAt(ref?: string): { hash: string; record: DecisionRecord }[] {
    const h = ref ? this.resolve(ref) : this.head();
    return h ? this.records(this.get<LedgerNode>(h).state) : [];
  }

  /** Records at a node that have not been superseded by a later one. */
  activeAt(ref?: string): { hash: string; record: DecisionRecord }[] {
    const all = this.stateAt(ref);
    const dead = new Set(all.map((r) => r.record.supersedes).filter(Boolean) as string[]);
    return all.filter((r) => !dead.has(r.hash));
  }

  diff(a: string, b: string): { added: string[]; removed: string[] } {
    const sa = new Set(this.get<LedgerNode>(this.resolve(a)).state);
    const sb = new Set(this.get<LedgerNode>(this.resolve(b)).state);
    return {
      added: [...sb].filter((h) => !sa.has(h)),
      removed: [...sa].filter((h) => !sb.has(h)),
    };
  }

  // ---------- small side state (watcher offsets etc.) ----------

  readMeta<T>(name: string, fallback: T): T {
    const p = path.join(this.dir, name);
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  writeMeta(name: string, value: unknown): void {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(value, null, 2));
  }
}
