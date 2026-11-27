/**
 * The engine's contract: what goes in, what comes out. README.md states the guarantees
 * in prose; keep the two in step.
 */

export type Author = "human" | "ai";

/** What the caller puts where it removed code. The engine never receives code. */
export const CODE_PLACEHOLDER = "[code omitted]";

/** One chat message. */
export interface EngineTurn {
  /**
   * The caller's id for this message; decisions are grounded to it. Ids may repeat (e.g.
   * content-addressed ids of identical messages): each decision gets the id of the turn it names.
   */
  id: string;
  author: Author;
  /** The message with every piece of code already replaced by CODE_PLACEHOLDER. */
  text: string;
}

/** A decision already in force, so the engine can skip repeats and spot replacements. */
export interface ActiveDecision {
  /** The caller's id for this decision, unique within one call; comes back in `supersedes`. */
  id: string;
  author: Author;
  decision: string;
}

export interface ExtractionInput {
  /** The new part of the conversation, oldest first. */
  turns: EngineTurn[];
  /** Decisions in force before these turns, oldest first. */
  activeDecisions: ActiveDecision[];
}

export interface ExtractedDecision {
  /** One short, specific sentence. Never empty. */
  decision: string;
  /** Why, only when the conversation says so. */
  rationale?: string;
  /** The id of the input turn that brought this decision. Always one of the input turn ids. */
  turnId: string;
  /** Always equal to that turn's author. */
  author: Author;
  /** A verbatim excerpt of that turn (ignoring case and whitespace). Dropped if it can't be found there. */
  quote?: string;
  /** The id of the active decision this one replaces: always one the model was shown (the latest 40). */
  supersedes?: string;
}

/** Any language model: takes a system prompt and a user message, returns the reply text. */
export type Model = (system: string, user: string) => Promise<string>;
