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

/** No model is configured or reachable; the fix is on the user's side (set a key or sign in). */
export class NoModelError extends Error {}
