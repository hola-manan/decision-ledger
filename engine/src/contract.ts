/**
 * The engine's contract: what goes in, what comes out. README.md states the guarantees
 * in prose; keep the two in step.
 */

export type AuthorKind = "human" | "ai";

/** Who brought a message: a person (by name) or an AI (by model name). Projects can have many people. */
export interface Author {
  kind: AuthorKind;
  name: string;
}

/** What the caller puts where it removed code. The engine never receives code. */
export const CODE_PLACEHOLDER = "[code omitted]";

/** Every grade is a whole number on this scale. */
export const GRADE_MIN = 1;
export const GRADE_MAX = 5;

/**
 * One thing each decision is graded on, e.g. reversibility. The set is chosen by the
 * caller (the project owner), never by the model; the model only gives the grades.
 */
export interface ParameterDefinition {
  /** Stable key used in `grades`: a letter, then letters, digits or underscores. */
  id: string;
  /** Human-readable name, e.g. "Reversibility". */
  name: string;
  /** What a grade of GRADE_MIN means, e.g. "practically irreversible". */
  low: string;
  /** What a grade of GRADE_MAX means, e.g. "trivial to undo". */
  high: string;
}

/** Parameter id → grade from GRADE_MIN to GRADE_MAX. */
export type Grades = Record<string, number>;

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
  /** What to grade each decision on. May be empty. */
  parameters: ParameterDefinition[];
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
  /** Only input parameter ids, only whole numbers from GRADE_MIN to GRADE_MAX. A grade the model didn't give is absent. */
  grades: Grades;
  /** The id of the active decision this one replaces: always one the model was shown (the latest 40). */
  supersedes?: string;
}

/** Any language model: takes a system prompt and a user message, returns the reply text. */
export type Model = (system: string, user: string) => Promise<string>;
