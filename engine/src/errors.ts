/** The input doesn't match the contract (see contract.ts). The message names the bad field. */
export class InvalidInputError extends Error {}

/**
 * The model's reply wasn't usable: not JSON, no decisions list, or no text at all. The
 * message stays fixed per cause (callers use it to recognise repeats); the reply is kept
 * apart because it carries conversation text.
 */
export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly reply = ""
  ) {
    super(message);
  }
}

/** No model is configured or reachable; the fix is on the user's side (set a key or sign in). */
export class NoModelError extends Error {}

/** A model provider's HTTP API refused or failed a request. */
export class ApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
