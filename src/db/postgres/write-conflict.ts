// ABOUTME: Recognizes PostgreSQL write races hidden inside database-driver error causes.
// ABOUTME: Lets transactional repositories return stable conflicts instead of driver failures.

type DatabaseFailure = Readonly<{
  code: string;
  constraint: string | null;
}>;

function databaseFailure(error: unknown): DatabaseFailure | null {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      typeof current !== "object" ||
      current === null ||
      visited.has(current)
    ) {
      return null;
    }
    visited.add(current);
    if ("code" in current && typeof current.code === "string") {
      return {
        code: current.code,
        constraint:
          "constraint" in current && typeof current.constraint === "string"
            ? current.constraint
            : null,
      };
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export function isRetryableWriteConflict(error: unknown) {
  const failure = databaseFailure(error);
  return failure?.code === "40001" || failure?.code === "40P01";
}

export function uniqueWriteConstraint(error: unknown) {
  const failure = databaseFailure(error);
  return failure?.code === "23505" ? failure.constraint : null;
}
