// ABOUTME: Verifies the ephemeral support-handoff gate and its isolated route failures.
// ABOUTME: Proves low requester/process ceilings reset without retaining network identity.
import assert from "node:assert/strict";
import test from "node:test";

import {
  anonymousHandoffRequesterKey,
  createHandoffRequestGate,
  handoffRequestProcessLimit,
  handoffRequestRequesterLimit,
  handoffRequestWindowMilliseconds,
} from "@/handoff/gate";
import { handleHandoffRequest } from "@/handoff/route";

const handoffUrl = "https://help.example.test/api/handoff";
const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";

function handoffRequest(headers: Record<string, string> = {}) {
  return new Request(handoffUrl, {
    body: JSON.stringify({}),
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...headers,
    },
    method: "POST",
  });
}

test("applies a low requester limit and resets one-minute ephemeral state", async () => {
  const gate = createHandoffRequestGate(async (request) =>
    request.headers.get("x-test-requester"),
  );
  const firstWindow = handoffRequestWindowMilliseconds * 10 + 1;
  const firstRequester = handoffRequest({ "x-test-requester": "first" });

  for (let index = 0; index < handoffRequestRequesterLimit; index += 1) {
    assert.deepEqual(await gate(firstRequester, firstWindow), { accepted: true });
  }
  assert.deepEqual(await gate(firstRequester, firstWindow), {
    accepted: false,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(
    await gate(handoffRequest({ "x-test-requester": "second" }), firstWindow),
    { accepted: true },
  );
  assert.deepEqual(
    await gate(firstRequester, firstWindow + handoffRequestWindowMilliseconds),
    { accepted: true },
  );
});

test("enforces the process ceiling without portable requester identity", async () => {
  const gate = createHandoffRequestGate(async () => null);
  const request = handoffRequest();
  for (let index = 0; index < handoffRequestProcessLimit; index += 1) {
    assert.deepEqual(await gate(request, 1), { accepted: true });
  }
  assert.deepEqual(await gate(request, 1), {
    accepted: false,
    retryAfterSeconds: 60,
  });
});

test("hashes only Cloudflare-trusted addresses in ephemeral memory", async () => {
  const request = handoffRequest({ "cf-connecting-ip": "203.0.113.7" });
  const first = await anonymousHandoffRequesterKey(request, "d1");
  const second = await anonymousHandoffRequesterKey(request, "d1");
  const other = await anonymousHandoffRequesterKey(
    handoffRequest({ "cf-connecting-ip": "203.0.113.8" }),
    "d1",
  );

  assert.match(first!, /^[a-f\d]{64}$/u);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(await anonymousHandoffRequesterKey(request, "postgres"), null);
});

test("rejects gate exhaustion and outages before service construction", async () => {
  let serviceCalls = 0;
  for (const fixture of [
    {
      allowance: async () => ({
        accepted: false as const,
        retryAfterSeconds: 17,
      }),
      expectedRetry: "17",
      expectedStatus: 429,
    },
    {
      allowance: async () => {
        throw new Error("private requester and infrastructure details");
      },
      expectedRetry: null,
      expectedStatus: 503,
    },
  ]) {
    const response = await handleHandoffRequest(handoffRequest(), {
      consumeAllowance: fixture.allowance,
      createService: async () => {
        serviceCalls += 1;
        throw new Error("not reached");
      },
    });
    const body = await response.text();

    assert.equal(response.status, fixture.expectedStatus);
    assert.equal(response.headers.get("retry-after"), fixture.expectedRetry);
    assert.deepEqual(JSON.parse(body), { error: "unavailable" });
    assert.doesNotMatch(body, /private|requester|infrastructure/u);
  }
  assert.equal(serviceCalls, 0);
});
