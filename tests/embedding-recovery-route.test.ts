// ABOUTME: Verifies the private recovery endpoint's authentication and response boundary.
// ABOUTME: Proves weak secrets and runtime failures cannot expose embedding inputs or credentials.
import assert from "node:assert/strict";
import test from "node:test";

import { handleEmbeddingRecoveryRequest } from "@/ai/embedding-recovery-route";

const recoveryUrl = "https://opas.example.test/api/internal/embeddings";
const secret = "embedding-recovery-secret-with-32-bytes";
const privateValue = "private-provider-key-and-prompt";

function request(authorization?: string) {
  return new Request(recoveryUrl, {
    method: "GET",
    headers: authorization ? { authorization } : undefined,
  });
}

function assertPrivateResponseHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("rejects absent or weak deployment secrets before recovery runs", async () => {
  let recoveryCalls = 0;

  for (const configuredSecret of [undefined, "too-short"]) {
    const response = await handleEmbeddingRecoveryRequest(request(), {
      configuredSecret,
      recover: async () => {
        recoveryCalls += 1;
        throw new Error("should not run");
      },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
    assertPrivateResponseHeaders(response);
  }

  assert.equal(recoveryCalls, 0);
});

test("rejects missing, malformed, and incorrect bearer credentials", async () => {
  let recoveryCalls = 0;

  for (const authorization of [
    undefined,
    secret,
    `Basic ${secret}`,
    "Bearer incorrect-embedding-recovery-secret-value",
  ]) {
    const response = await handleEmbeddingRecoveryRequest(request(authorization), {
      configuredSecret: secret,
      recover: async () => {
        recoveryCalls += 1;
        throw new Error("should not run");
      },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { status: "unauthorized" });
    assertPrivateResponseHeaders(response);
  }

  assert.equal(recoveryCalls, 0);
});

test("returns only the redacted recovery summary for an authorized invocation", async () => {
  const response = await handleEmbeddingRecoveryRequest(
    request(`Bearer ${secret}`),
    {
      configuredSecret: secret,
      recover: async () => ({
        status: "completed",
        processedJobCount: 1,
        embeddedChunkCount: 4,
        activated: true,
      }),
    },
  );

  assert.equal(response.status, 200);
  assertPrivateResponseHeaders(response);
  assert.deepEqual(await response.json(), {
    status: "completed",
    processedJobCount: 1,
    embeddedChunkCount: 4,
    activated: true,
  });
});

test("contains private runtime failures and reports only safe details", async () => {
  const reported: unknown[] = [];
  const response = await handleEmbeddingRecoveryRequest(
    request(`Bearer ${secret}`),
    {
      configuredSecret: secret,
      recover: async () => {
        throw Object.assign(new Error(privateValue), {
          code: "PROVIDER_DOWN",
          requestBody: privateValue,
        });
      },
      reportFailure(details) {
        reported.push(details);
      },
    },
  );

  assert.equal(response.status, 503);
  assertPrivateResponseHeaders(response);
  const body = await response.json();
  assert.deepEqual(body, { status: "unavailable" });
  assert.deepEqual(reported, [{ type: "Error" }]);
  assert.doesNotMatch(
    JSON.stringify({ body, reported }),
    /private-provider-key-and-prompt/u,
  );
});
