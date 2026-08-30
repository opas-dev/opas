// ABOUTME: Verifies Vercel artifacts bind their runtime Neon URL to the prepared database.
// ABOUTME: Keeps project environment drift from opening or mutating a different branch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { assertNeonConnectionIdentity } from "../src/db/neon/client";

const connectionString =
  "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas?sslmode=require";
const expectedHash = createHash("sha256")
  .update(connectionString)
  .digest("hex");

test("accepts the exact Neon URL selected when the artifact was built", () => {
  assert.doesNotThrow(() =>
    assertNeonConnectionIdentity(connectionString, expectedHash),
  );
});

test("fails closed when the project Neon URL drifts or the artifact hash is absent", () => {
  assert.throws(() =>
    assertNeonConnectionIdentity(`${connectionString}&application=other`, expectedHash),
  );
  assert.throws(() => assertNeonConnectionIdentity(connectionString, undefined));
  assert.throws(() => assertNeonConnectionIdentity(connectionString, "invalid"));
});
