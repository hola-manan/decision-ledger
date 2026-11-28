/**
 * The session the panel shows, rebuilt from its log (D-017: no cache). Reads from the start
 * through the shared source, then takes appends: no gap, no overlap (D-003).
 */
import type { LogBatch, SessionFile, SessionLogSource } from "../claude-log";
import { ExchangeBuilder, type Exchange } from "./exchanges";

export class FollowedSession {
  readonly builder: ExchangeBuilder;
  /** When the log last grew (epoch ms): drives "may be waiting" and "incomplete". */
  quietSince: number;

  constructor(
    readonly file: SessionFile,
    source: SessionLogSource
  ) {
    this.builder = new ExchangeBuilder(file.sessionId);
    this.builder.apply(source.read(file.file, 0).entries);
    this.quietSince = file.modifiedAt;
  }

  /** Ids of the exchanges that changed. */
  apply(batch: LogBatch, now: number): string[] {
    this.quietSince = now;
    return this.builder.apply(batch.entries);
  }

  exchanges(): readonly Exchange[] {
    return this.builder.exchanges();
  }

  exchange(id: string): Exchange | undefined {
    return this.builder.exchanges().find((e) => e.id === id);
  }

  latest(): Exchange | undefined {
    return this.builder.exchanges().at(-1);
  }

  /** The first prompt, for the session line. */
  firstPrompt(): string | undefined {
    return this.builder.exchanges()[0]?.prompt.text;
  }
}
