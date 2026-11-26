/**
 * Retry policy for a background job that keeps failing (e.g. no model configured):
 * wait longer after each consecutive failure, and report each distinct error once.
 */

export const FIRST_RETRY_DELAY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 10 * 60_000;

export class RetryBackoff {
  private failures = 0;
  private retryAt = 0;
  private lastError: string | undefined;

  canTry(now: number): boolean {
    return now >= this.retryAt;
  }

  /** Records a failure and schedules the next try. Returns whether this error is new and worth reporting. */
  fail(error: string, now: number): boolean {
    this.failures++;
    this.retryAt = now + Math.min(FIRST_RETRY_DELAY_MS * 2 ** (this.failures - 1), MAX_RETRY_DELAY_MS);
    const isNew = error !== this.lastError;
    this.lastError = error;
    return isNew;
  }

  /** After a success, or when something changed that may fix the failure (e.g. a key was set). */
  reset(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.lastError = undefined;
  }
}
