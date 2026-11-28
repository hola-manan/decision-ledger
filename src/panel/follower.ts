/**
 * Which Claude Code session the panel follows. In auto mode it is the session the person
 * last typed into; pinned, it stays on one session until that file disappears. No vscode:
 * the caller saves the choice (workspaceState) and restores it.
 */
import { Listeners, type LogBatch, type SessionFile, type SessionLogSource, type Unsubscribe } from "../claude-log";

export type FollowChoice = { mode: "auto" } | { mode: "pinned"; sessionId: string };

export class SessionFollower {
  private choice: FollowChoice;
  private followed: string | undefined;
  private readonly changed = new Listeners<SessionFile | undefined>();
  private readonly subscriptions: Unsubscribe[];
  /** File → time of the newest prompt seen in it (epoch ms, from the prompt's own timestamp). */
  private readonly lastPromptAt = new Map<string, number>();
  /** Prompts older than this, replayed from a file read from its start, never move the panel. */
  private readonly followingSince: number;

  /**
   * Construct it after acquiring the source: the first scan has then run, so in auto mode
   * the newest session is followed from the start. A pinned session that no longer exists
   * falls back to auto (and that choice is saved). It keeps source.watchClosely on the
   * followed file.
   */
  constructor(
    private readonly source: SessionLogSource,
    initial: FollowChoice,
    private readonly save: (choice: FollowChoice) => void,
    now: () => number = Date.now
  ) {
    this.choice = initial;
    this.followingSince = now();
    const pinned = initial.mode === "pinned" ? this.find(initial.sessionId) : undefined;
    if (initial.mode === "pinned" && !pinned) this.setChoice({ mode: "auto" });
    this.followed = (pinned ?? this.newest())?.file;
    source.watchClosely(this.followed);
    this.subscriptions = [
      source.onDidAppend((batch) => this.onAppend(batch)),
      source.onDidDiscover(() => this.onDiscover()),
      source.onDidRemove((file) => this.onRemove(file)),
    ];
  }

  get mode(): FollowChoice["mode"] {
    return this.choice.mode;
  }

  /** The followed session, with its latest size and time. */
  current(): SessionFile | undefined {
    return this.followed ? this.source.sessions().find((s) => s.file === this.followed) : undefined;
  }

  /** Follows this session until followLatest, or until its file disappears. False if it isn't known. */
  pin(sessionId: string): boolean {
    const session = this.find(sessionId);
    if (!session) return false;
    this.choose({ mode: "pinned", sessionId }, session.file);
    return true;
  }

  /** Back to auto: the session with the newest prompt seen, else the most recently changed one. */
  followLatest(): void {
    this.choose({ mode: "auto" }, this.latestPrompted() ?? this.newest()?.file);
  }

  /** Fires when the followed session or the follow mode changes. */
  onDidChange(listener: (file: SessionFile | undefined) => void): Unsubscribe {
    return this.changed.add(listener);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.source.watchClosely(undefined);
  }

  /**
   * In auto mode a prompt typed into another session moves the panel there; replies alone
   * don't, and neither do old prompts replayed from a file read from its start.
   */
  private onAppend(batch: LogBatch): void {
    const prompts = batch.entries.filter((entry) => entry.kind === "prompt");
    if (prompts.length === 0) return;
    const newest = Math.max(...prompts.map((p) => Date.parse(p.timestamp) || this.followingSince));
    this.lastPromptAt.set(batch.file, Math.max(newest, this.lastPromptAt.get(batch.file) ?? 0));
    if (this.choice.mode !== "auto" || batch.file === this.followed) return;
    const followedSince = this.followed ? this.lastPromptAt.get(this.followed) ?? this.followingSince : 0;
    if (newest >= followedSince) this.switchTo(batch.file);
  }

  /** With nothing followed, the newest session is; discovery order says nothing about recency. */
  private onDiscover(): void {
    if (this.choice.mode === "auto" && !this.followed) this.switchTo(this.newest()?.file);
  }

  private onRemove(file: string): void {
    this.lastPromptAt.delete(file);
    if (file !== this.followed) return;
    const next = this.latestPrompted() ?? this.newest()?.file;
    if (this.choice.mode === "pinned") this.choose({ mode: "auto" }, next);
    else this.switchTo(next);
  }

  /** Sets the choice and the file; one change event if either changed. */
  private choose(choice: FollowChoice, file: string | undefined): void {
    const modeChanged = choice.mode !== this.choice.mode;
    this.setChoice(choice);
    if (!this.switchTo(file) && modeChanged) this.changed.emit(this.current());
  }

  /** True if the followed file changed (and the change was announced). */
  private switchTo(file: string | undefined): boolean {
    if (file === this.followed) return false;
    this.followed = file;
    this.source.watchClosely(file);
    this.changed.emit(this.current());
    return true;
  }

  private setChoice(choice: FollowChoice): void {
    this.choice = choice;
    this.save(choice);
  }

  private find(sessionId: string): SessionFile | undefined {
    return this.source.sessions().find((s) => s.sessionId === sessionId);
  }

  /** sessions() is newest first. */
  private newest(): SessionFile | undefined {
    return this.source.sessions()[0];
  }

  private latestPrompted(): string | undefined {
    let latest: string | undefined;
    let at = -Infinity;
    for (const [file, seen] of this.lastPromptAt) if (seen > at) [latest, at] = [file, seen];
    return latest;
  }
}
