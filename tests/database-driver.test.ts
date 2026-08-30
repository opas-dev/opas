// ABOUTME: Verifies artifact-owned database targets cannot drift through project settings.
// ABOUTME: Covers explicit portable drivers and the local Postgres default.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveDatabaseDriver } from "../src/db/driver";

test("resolves every explicit portable database driver", () => {
  for (const driver of ["d1", "neon", "postgres"] as const) {
    assert.equal(resolveDatabaseDriver({ OPAS_DATABASE_DRIVER: driver }), driver);
  }
  assert.equal(resolveDatabaseDriver({}), "postgres");
});

test("requires project settings to match an artifact-owned database target", () => {
  assert.equal(
    resolveDatabaseDriver({
      OPAS_DATABASE_DRIVER: "neon",
    }, "neon"),
    "neon",
  );
  for (const driver of [undefined, "d1", "postgres"]) {
    assert.throws(() =>
      resolveDatabaseDriver({
        OPAS_DATABASE_DRIVER: driver,
      }, "neon"),
    );
  }
});

test("rejects unsupported project database drivers", () => {
  assert.throws(() =>
    resolveDatabaseDriver({ OPAS_DATABASE_DRIVER: "unexpected" }),
  );
});
