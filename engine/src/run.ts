#!/usr/bin/env node
/**
 * Runs the engine on one input file and prints the result, so it can be tried and
 * evaluated without the extension:
 *
 *   GEMINI_API_KEY=... npm run extract -- examples/conversation.json
 *   cat input.json | ANTHROPIC_API_KEY=... npm run extract
 *
 * Input: ExtractionInput as JSON. Output: {"decisions": ExtractedDecision[]} on stdout.
 */
import * as fs from "fs";
import { extractDecisions, InvalidInputError, ModelOutputError, modelFromEnv, parseExtractionInput } from "./index";

async function main() {
  const [file] = process.argv.slice(2);
  const input = parseExtractionInput(parseJsonInput(file ? fs.readFileSync(file, "utf8") : await readStdin()));
  const decisions = await extractDecisions(input, modelFromEnv());
  console.log(JSON.stringify({ decisions }, null, 2));
}

function parseJsonInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InvalidInputError(`input is not JSON: ${(e as Error).message}`);
  }
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

main().catch((e) => {
  console.error(`${e?.constructor?.name ?? "Error"}: ${e?.message ?? e}`);
  // Shown here, where the person running it asked for it; the extension never logs replies.
  if (e instanceof ModelOutputError && e.reply) console.error(`Model reply:\n${e.reply}`);
  process.exit(1);
});
