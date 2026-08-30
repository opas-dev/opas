// ABOUTME: Verifies the bounded public answer-outcome HTTP boundary and abuse gate.
// ABOUTME: Proves feedback is update-only, privacy-safe, and existence-oblivious.
import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePublicOutcomeRequest,
  maximumOutcomeWriteBodyUtf8Bytes,
} from "@/outcomes/route";

const url = "https://help.example.test/api/answers/outcomes";
const conversationId = "123e4567-e89b-42d3-a456-426614174000";

function request(
  body: BodyInit = JSON.stringify({ conversationId, outcome: "low-rated" }),
  options: Readonly<{ contentType?: string; method?: string }> = {},
) {
  return new Request(url, {
    body: options.method === "GET" ? undefined : body,
    headers: {
      "content-type": options.contentType ?? "application/json; charset=utf-8",
    },
    method: options.method ?? "POST",
  });
}

const acceptedGate = async () => ({ accepted: true as const });

test("accepts bounded optional feedback without revealing whether a record exists", async () => {
  const calls: unknown[][] = [];
  for (const result of ["updated", "missing"] as const) {
    const response = await handlePublicOutcomeRequest(
      request(
        JSON.stringify({
          conversationId,
          outcome: "low-rated",
          reason: "The steps skipped my device.",
        }),
      ),
      {
        consumeAllowance: acceptedGate,
        recordOutcome: async (...parameters) => {
          calls.push(parameters);
          return result;
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(calls, [
    [conversationId, "low-rated", "The steps skipped my device."],
    [conversationId, "low-rated", "The steps skipped my device."],
  ]);
});

test("rejects methods, media types, malformed IDs, unknown fields, controls, and byte excess", async () => {
  const fixtures: Array<[Request, number]> = [
    [request("", { method: "GET" }), 405],
    [request("{}", { contentType: "text/plain" }), 415],
    [request("{"), 400],
    [request(JSON.stringify({ conversationId: "caller-choice", outcome: "low-rated" })), 400],
    [request(JSON.stringify({ conversationId, outcome: "answered" })), 400],
    [request(JSON.stringify({ conversationId, outcome: "low-rated", rawUa: "secret" })), 400],
    [
      request(
        JSON.stringify({ conversationId, outcome: "low-rated", reason: "bad\u0001" }),
      ),
      400,
    ],
    [request("x".repeat(maximumOutcomeWriteBodyUtf8Bytes + 1)), 413],
  ];
  let writes = 0;
  for (const [input, expectedStatus] of fixtures) {
    const response = await handlePublicOutcomeRequest(input, {
      consumeAllowance: acceptedGate,
      recordOutcome: async () => {
        writes += 1;
        return "updated";
      },
    });
    assert.equal(response.status, expectedStatus);
  }
  assert.equal(writes, 0);
});

test("applies the public gate before storage and returns bounded retry metadata", async () => {
  let writes = 0;
  const limited = await handlePublicOutcomeRequest(request(), {
    consumeAllowance: async () => ({
      accepted: false,
      retryAfterSeconds: 19,
    }),
    recordOutcome: async () => {
      writes += 1;
      return "updated";
    },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "19");
  assert.deepEqual(await limited.json(), { error: "rate-limited" });
  assert.equal(writes, 0);

  const unavailable = await handlePublicOutcomeRequest(request(), {
    consumeAllowance: async () => {
      throw new Error("private requester IP");
    },
  });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /private|requester|IP/u);
});

test("contains persistence failures without logging feedback, requester data, or secrets", async () => {
  const reports: unknown[] = [];
  const response = await handlePublicOutcomeRequest(
    request(
      JSON.stringify({
        conversationId,
        outcome: "abandoned",
        reason: "reader@example.com password=x",
      }),
    ),
    {
      consumeAllowance: acceptedGate,
      recordOutcome: async () => {
        throw new Error("database secret and 203.0.113.7");
      },
      reportFailure: (details) => reports.push(details),
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(reports, [{ type: "Error" }]);
  const body = await response.text();
  assert.doesNotMatch(body, /reader|password|database|203\.0\.113/u);
});
