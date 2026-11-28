/**
 * The panel's two timers: one coalesces exchange updates (at most one per exchange per
 * LIVE_UPDATE_MIN_INTERVAL_MS, D-013), one wakes the panel when quiet alone changes what
 * an exchange means. No vscode; the clock is injected so tests drive time.
 */

/** Updates to one exchange are sent at most this often (D-013). */
export const LIVE_UPDATE_MIN_INTERVAL_MS = 250;

export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class UpdateScheduler {
  private readonly pending = new Set<string>();
  private flushTimer: unknown;
  private wakeTimer: unknown;

  constructor(
    private readonly clock: Clock,
    private readonly send: (exchangeIds: string[]) => void
  ) {}

  /** Sends these exchanges with the next flush, at most LIVE_UPDATE_MIN_INTERVAL_MS from now. */
  queue(exchangeIds: Iterable<string>): void {
    for (const id of exchangeIds) this.pending.add(id);
    if (this.pending.size > 0 && this.flushTimer === undefined) {
      this.flushTimer = this.clock.setTimeout(() => this.flush(), LIVE_UPDATE_MIN_INTERVAL_MS);
    }
  }

  /** Sends what is queued now, and cancels the pending flush so no second timer is left behind. */
  flush(): void {
    this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const ids = [...this.pending];
    this.pending.clear();
    if (ids.length) this.send(ids);
  }

  /** Forgets what is queued: a snapshot just sent everything. */
  discard(): void {
    this.pending.clear();
  }

  /** Runs once at `at` (epoch ms), replacing any earlier wake-up; undefined cancels it. */
  wakeAt(at: number | undefined, run: () => void): void {
    this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    if (at !== undefined) this.wakeTimer = this.clock.setTimeout(run, Math.max(0, at - this.clock.now()));
  }

  dispose(): void {
    this.clock.clearTimeout(this.flushTimer);
    this.clock.clearTimeout(this.wakeTimer);
    this.pending.clear();
  }
}
