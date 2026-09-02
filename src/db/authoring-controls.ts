// ABOUTME: Defines the stable failure boundary for paused workspace authoring.
// ABOUTME: Normalizes driver-specific trigger failures without exposing database details.
import { sql } from "drizzle-orm";

export const authoringPausedCode = "AUTHORING_PAUSED" as const;

export class AuthoringPausedError extends Error {
  readonly code = authoringPausedCode;

  constructor() {
    super(authoringPausedCode);
    this.name = "AuthoringPausedError";
  }
}

function containsAuthoringPaused(
  value: unknown,
  visited = new Set<unknown>(),
): boolean {
  if (typeof value === "string") {
    return value.includes(authoringPausedCode);
  }
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (
    ("message" in value && containsAuthoringPaused(value.message, visited)) ||
    ("code" in value && containsAuthoringPaused(value.code, visited)) ||
    ("cause" in value && containsAuthoringPaused(value.cause, visited))
  ) {
    return true;
  }
  if (value instanceof AggregateError) {
    return value.errors.some((error) => containsAuthoringPaused(error, visited));
  }
  return false;
}

export function normalizeAuthoringError(error: unknown): unknown {
  return containsAuthoringPaused(error) ? new AuthoringPausedError() : error;
}

export function authoringAssertion(
  workspaceId: string,
  dialect: "postgres" | "sqlite",
) {
  return dialect === "postgres"
    ? sql`select opas_assert_authoring_open(${workspaceId})`
    : sql`insert into workspace_authoring_assertions (workspace_id) values (${workspaceId})`;
}

export function withAuthoringErrorBoundary<T extends object>(repository: T): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(value, target, args);
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              throw normalizeAuthoringError(error);
            });
          }
          return result;
        } catch (error) {
          throw normalizeAuthoringError(error);
        }
      };
    },
  });
}
