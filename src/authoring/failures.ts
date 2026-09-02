// ABOUTME: Maps the durable authoring fence error to stable application-facing failures.
// ABOUTME: Keeps route and Server Action responses consistent without exposing database details.
import {
  AuthoringPausedError,
  authoringPausedCode,
  normalizeAuthoringError,
} from "@/db/authoring-controls";

export const authoringPausedMessage =
  "Authoring is temporarily paused for maintenance. Try again after it resumes.";

export type AuthoringPausedFailure = Readonly<{
  code: typeof authoringPausedCode;
  message: typeof authoringPausedMessage;
}>;

const pausedFailure = Object.freeze({
  code: authoringPausedCode,
  message: authoringPausedMessage,
}) satisfies AuthoringPausedFailure;

export function getAuthoringPausedFailure(
  error: unknown,
): AuthoringPausedFailure | null {
  return normalizeAuthoringError(error) instanceof AuthoringPausedError
    ? pausedFailure
    : null;
}

export function authoringPausedResponse(error: unknown): Response | null {
  const failure = getAuthoringPausedFailure(error);
  return failure
    ? Response.json(failure, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      })
    : null;
}
