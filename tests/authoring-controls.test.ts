// ABOUTME: Verifies stable paused-authoring errors across nested database driver failures.
// ABOUTME: Keeps repository callers independent from Postgres, Neon, SQLite, and D1 messages.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthoringPausedError,
  normalizeAuthoringError,
  withAuthoringErrorBoundary,
} from "@/db/authoring-controls";

test("normalizes direct, caused, and aggregate fence failures", () => {
  const failures = [
    new Error("AUTHORING_PAUSED"),
    Object.assign(new Error("database write failed"), {
      cause: new Error("trigger: AUTHORING_PAUSED"),
    }),
    new AggregateError(
      [new Error("save failed"), { code: "AUTHORING_PAUSED" }],
      "cleanup also failed",
    ),
  ];

  for (const failure of failures) {
    const normalized = normalizeAuthoringError(failure);
    assert.ok(normalized instanceof AuthoringPausedError);
    assert.equal(normalized.code, "AUTHORING_PAUSED");
    assert.equal(normalized.message, "AUTHORING_PAUSED");
  }
});

test("does not replace unrelated database errors", () => {
  const failure = new Error("UNIQUE constraint failed");
  assert.equal(normalizeAuthoringError(failure), failure);
});

test("repository boundary normalizes async and synchronous failures", async () => {
  const repository = withAuthoringErrorBoundary({
    async asyncWrite() {
      throw new Error("D1_ERROR: AUTHORING_PAUSED");
    },
    syncWrite() {
      throw Object.assign(new Error("Postgres write rejected"), {
        cause: { message: "AUTHORING_PAUSED" },
      });
    },
  });

  await assert.rejects(
    repository.asyncWrite(),
    (error) => error instanceof AuthoringPausedError,
  );
  assert.throws(
    () => repository.syncWrite(),
    (error) => error instanceof AuthoringPausedError,
  );
});
