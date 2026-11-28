/** Shared by the panel tests: fixtures and inline log lines → exchanges. */
import * as fs from "fs";
import * as path from "path";
import { parseLogLines, type LogEntry } from "../src/claude-log";
import { ExchangeBuilder, type Exchange } from "../src/panel/exchanges";

export const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "claude-log");
export const SESSION = "session-1";

/** Complete lines of a fixture (every fixture ends with a newline), parsed from offset 0. */
export function fixture(name: string): LogEntry[] {
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8");
  return parseLogLines(text.split("\n").slice(0, -1), 0);
}

/** Inline JSONL lines → entries, with byte offsets as if they were one file. */
export function lines(...objects: object[]): LogEntry[] {
  return parseLogLines(objects.map((o) => JSON.stringify(o)), 0);
}

export function build(entries: LogEntry[]): ExchangeBuilder {
  const builder = new ExchangeBuilder(SESSION);
  builder.apply(entries);
  return builder;
}

/** Every exchange in these inline lines. */
export function exchangesOf(objects: object[]): readonly Exchange[] {
  return build(lines(...objects)).exchanges();
}

/** The first exchange in these inline lines. */
export function exchangeOf(objects: object[]): Exchange {
  return exchangesOf(objects)[0];
}

/** The first exchange of a fixture. */
export function fixtureExchange(name: string): Exchange {
  return build(fixture(name)).exchanges()[0];
}
