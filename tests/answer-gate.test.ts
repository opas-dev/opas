// ABOUTME: Verifies the ephemeral public answer gate and its isolated route failures.
// ABOUTME: Proves requester/process ceilings reset safely without exposing network identity.
import assert from "node:assert/strict";
import test from "node:test";

import {
  anonymousAnswerRequesterKey,
  answerRequestProcessLimit,
  answerRequestRequesterLimit,
  answerRequestWindowMilliseconds,
  createAnswerRequestGate,
} from "@/answers/gate";
import { handleAnswerRequest } from "@/answers/answer-route";

const answerUrl = "https://help.example.test/api/answers";

function answerRequest(headers: Record<string, string> = {}) {
  return new Request(answerUrl, {
    body: JSON.stringify({ question: "How do I reset my password?" }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

test("applies independent requester limits and resets one-minute ephemeral state", async () => {
  const gate = createAnswerRequestGate(async (request) =>
    request.headers.get("x-test-requester"),
  );
  const firstWindow = answerRequestWindowMilliseconds * 10 + 1;
  const firstRequester = answerRequest({ "x-test-requester": "first" });

  for (let index = 0; index < answerRequestRequesterLimit; index += 1) {
    assert.deepEqual(await gate(firstRequester, firstWindow), { accepted: true });
  }
  assert.deepEqual(await gate(firstRequester, firstWindow), {
    accepted: false,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(
    await gate(answerRequest({ "x-test-requester": "second" }), firstWindow),
    { accepted: true },
  );
  assert.deepEqual(
    await gate(firstRequester, firstWindow + answerRequestWindowMilliseconds),
    { accepted: true },
  );
});

test("enforces the process ceiling even when requester identity is unavailable", async () => {
  const gate = createAnswerRequestGate(async () => null);
  const request = answerRequest();
  for (let index = 0; index < answerRequestProcessLimit; index += 1) {
    assert.deepEqual(await gate(request, 1), { accepted: true });
  }
  assert.deepEqual(await gate(request, 1), {
    accepted: false,
    retryAfterSeconds: 60,
  });
});

test("hashes only Cloudflare-trusted requester addresses in ephemeral memory", async () => {
  const request = answerRequest({ "cf-connecting-ip": "203.0.113.7" });
  const first = await anonymousAnswerRequesterKey(request, "d1");
  const second = await anonymousAnswerRequesterKey(request, "d1");
  const other = await anonymousAnswerRequesterKey(
    answerRequest({ "cf-connecting-ip": "203.0.113.8" }),
    "d1",
  );

  assert.match(first!, /^[a-f\d]{64}$/u);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(await anonymousAnswerRequesterKey(request, "postgres"), null);
});

test("rejects gate exhaustion and outages before runtime creation with redacted responses", async () => {
  let runtimeCalls = 0;
  for (const fixture of [
    {
      allowance: async () => ({
        accepted: false as const,
        retryAfterSeconds: 17,
      }),
      expectedStatus: 429,
      expectedRetry: "17",
    },
    {
      allowance: async () => {
        throw new Error("private requester and infrastructure details");
      },
      expectedStatus: 503,
      expectedRetry: null,
    },
  ]) {
    const response = await handleAnswerRequest(answerRequest(), {
      consumeAllowance: fixture.allowance,
      createRuntime: async () => {
        runtimeCalls += 1;
        throw new Error("not reached");
      },
    });
    const body = await response.text();

    assert.equal(response.status, fixture.expectedStatus);
    assert.equal(response.headers.get("retry-after"), fixture.expectedRetry);
    assert.deepEqual(JSON.parse(body), { error: "unavailable" });
    assert.doesNotMatch(body, /private|requester|infrastructure/u);
  }
  assert.equal(runtimeCalls, 0);
});
