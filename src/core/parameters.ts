/**
 * The grading parameters live in .ledger/config.json, which the project owner edits by
 * hand. The AI only grades against them; it never chooses them. Changing the set later
 * is safe: each record keeps a reference to the set it was graded against.
 */
import * as fs from "fs";
import * as path from "path";
import { InvalidInputError, parseParameterDefinitions, ParameterDefinition } from "../../engine/src";
import type { Ledger } from "./store";

export const CONFIG_FILE = "config.json";

/** The starting set, written to config.json the first time; edit the file to change it. */
export const DEFAULT_PARAMETERS: ParameterDefinition[] = [
  {
    id: "codeSpan",
    name: "Code span",
    low: "touches a single line or function",
    high: "touches the whole codebase",
  },
  {
    id: "reversibility",
    name: "Reversibility",
    low: "practically irreversible (data, public API, contracts others depend on)",
    high: "trivial to undo",
  },
];

/** config.json can't be used as it is; the fix is for the project owner to edit it. */
export class ConfigError extends Error {}

interface Config {
  parameters: ParameterDefinition[];
}

/** Path of the config file, created with the default parameters if it doesn't exist yet. */
export function ensureConfigFile(ledger: Ledger): string {
  const file = path.join(ledger.dir, CONFIG_FILE);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ parameters: DEFAULT_PARAMETERS } satisfies Config, null, 2) + "\n");
  return file;
}

/** The current parameter set. A broken config is an error to fix, never silently replaced by defaults. */
export function loadParameters(ledger: Ledger): ParameterDefinition[] {
  const file = ensureConfigFile(ledger);
  const config = parseConfigJson(fs.readFileSync(file, "utf8"));
  try {
    return parseParameterDefinitions(config.parameters, `.ledger/${CONFIG_FILE} parameters`);
  } catch (e) {
    if (e instanceof InvalidInputError) throw new ConfigError(e.message);
    throw e;
  }
}

function parseConfigJson(text: string): Record<string, unknown> {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`.ledger/${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new ConfigError(`.ledger/${CONFIG_FILE}: expected an object`);
  return config as Record<string, unknown>;
}
