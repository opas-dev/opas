// ABOUTME: Verifies the in-process public outcome write limits on every database target.
// ABOUTME: Proves Cloudflare requester limits use only ephemeral platform identity.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createOutcomeWriteGate,
  outcomeWriteProcessLimit,
  outcomeWriteRequesterLimit,
  outcomeWriteWindowMilliseconds,
} from "@/outcomes/gate";

const url = "https://help.example.test/api/answers/outcomes";

function request(headers: HeadersInit = {}) {
  return new Request(url, { headers, method: "POST" });
}

function setDatabaseDriver(value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, "OPAS_DATABASE_DRIVER");
    return;
  }
  Reflect.set(process.env, "OPAS_DATABASE_DRIVER", value);
}

test("limits every warm process and resets only when the minute advances", async () => {
  const gate = createOutcomeWriteGate(async () => null);
  for (let index = 0; index < outcomeWriteProcessLimit; index += 1) {
    assert.deepEqual(await gate(request(), 0), { accepted: true });
  }
  assert.deepEqual(await gate(request(), 0), {
    accepted: false,
    retryAfterSeconds: 60,
  });

  assert.deepEqual(await gate(request(), outcomeWriteWindowMilliseconds), {
    accepted: true,
  });
  assert.deepEqual(await gate(request(), 0), { accepted: true });
});

test("limits each Cloudflare requester without trusting forwarded identity", async (context) => {
  const previousDriver = process.env.OPAS_DATABASE_DRIVER;
  context.after(() => {
    setDatabaseDriver(previousDriver);
  });
  setDatabaseDriver("d1");

  const forwardedOnly = createOutcomeWriteGate();
  for (let index = 0; index <= outcomeWriteRequesterLimit; index += 1) {
    assert.deepEqual(
      await forwardedOnly(request({ "x-forwarded-for": "203.0.113.9" }), 1_234),
      { accepted: true },
    );
  }

  const gate = createOutcomeWriteGate();
  const first = request({ "cf-connecting-ip": "203.0.113.9" });
  for (let index = 0; index < outcomeWriteRequesterLimit; index += 1) {
    assert.deepEqual(await gate(first, 1_234), { accepted: true });
  }
  assert.deepEqual(await gate(first, 1_234), {
    accepted: false,
    retryAfterSeconds: 59,
  });
  assert.deepEqual(
    await gate(request({ "cf-connecting-ip": "203.0.113.10" }), 1_234),
    { accepted: true },
  );
  assert.deepEqual(await gate(first, outcomeWriteWindowMilliseconds), {
    accepted: true,
  });
});

test("Postgres and Neon ignore Cloudflare requester headers", async (context) => {
  const previousDriver = process.env.OPAS_DATABASE_DRIVER;
  context.after(() => {
    setDatabaseDriver(previousDriver);
  });

  for (const driver of ["postgres", "neon"] as const) {
    setDatabaseDriver(driver);
    const gate = createOutcomeWriteGate();
    for (let index = 0; index <= outcomeWriteRequesterLimit; index += 1) {
      assert.deepEqual(
        await gate(request({ "cf-connecting-ip": "203.0.113.9" }), 1_234),
        { accepted: true },
      );
    }
  }
});
