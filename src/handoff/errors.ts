// ABOUTME: Defines the fixed public failures shared by support-handoff boundaries.
// ABOUTME: Prevents provider responses, credentials, and submitted content from entering errors.

export type HandoffErrorCode =
  | "cancelled"
  | "configuration"
  | "conflict"
  | "delivery-failed"
  | "invalid-input"
  | "rate-limited"
  | "unavailable";

const messages: Readonly<Record<HandoffErrorCode, string>> = Object.freeze({
  cancelled: "Support handoff was cancelled",
  configuration: "Support handoff delivery is not configured",
  conflict: "Support handoff idempotency key conflicts with another request",
  "delivery-failed": "Support handoff delivery failed",
  "invalid-input": "Support handoff content is invalid",
  "rate-limited": "Support handoff capacity is temporarily exhausted",
  unavailable: "Support handoff is unavailable",
});

export class HandoffError extends Error {
  readonly code: HandoffErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: HandoffErrorCode, retryAfterSeconds?: number) {
    super(messages[code]);
    this.name = "HandoffError";
    this.code = code;
    this.retryAfterSeconds =
      code === "rate-limited" &&
      Number.isSafeInteger(retryAfterSeconds) &&
      (retryAfterSeconds as number) >= 1
        ? (retryAfterSeconds as number)
        : null;
  }
}
