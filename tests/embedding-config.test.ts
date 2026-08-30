// ABOUTME: Verifies deployment-specific embedding configuration without coupling worker logic to a runtime.
// ABOUTME: Keeps Cloudflare bindings and OpenAI-compatible secrets behind one validated adapter factory.
import assert from "node:assert/strict";
import test from "node:test";

import type { WorkersAiEmbeddingBinding } from "@/ai/embeddings";
import { createEmbeddingAdapter } from "@/ai/embedding-config";

function workersBinding(
  run: WorkersAiEmbeddingBinding["run"],
): WorkersAiEmbeddingBinding {
  return { run };
}

test("selects Workers AI with the fixed Cloudflare semantic configuration", async () => {
  const calls: Array<{ model: string; input: unknown }> = [];
  const run = (async (model: string, input: unknown) => {
    calls.push({ model, input });
    return {
      data: [Array.from({ length: 768 }, () => 0.25)],
      pooling: "cls",
      shape: [1, 768],
    };
  }) as unknown as WorkersAiEmbeddingBinding["run"];
  const adapter = await createEmbeddingAdapter({
    environment: { OPAS_DATABASE_DRIVER: "d1" },
    workersAiBinding: workersBinding(run),
  });

  const batch = await adapter.embed(["Current published evidence"]);

  assert.equal(adapter.metadata.provider, "cloudflare-workers-ai");
  assert.equal(adapter.metadata.dimension, 768);
  assert.deepEqual(adapter.metadata.configuration, { pooling: "cls" });
  assert.equal(batch.vectors[0]?.length, 768);
  assert.deepEqual(calls, [
    {
      model: "@cf/baai/bge-base-en-v1.5",
      input: { pooling: "cls", text: ["Current published evidence"] },
    },
  ]);
});

test("selects the configured OpenAI-compatible endpoint outside Cloudflare", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const adapter = await createEmbeddingAdapter({
    environment: {
      OPAS_DATABASE_DRIVER: "neon",
      OPAS_EMBEDDING_API_KEY: "private-provider-key",
      OPAS_EMBEDDING_DIMENSION: "3",
      OPAS_EMBEDDING_DIMENSIONS_PARAMETER: "true",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
    },
    fetch: async (input, init) => {
      requests.push({ input, init });
      return Response.json({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      });
    },
  });

  await adapter.embed(["Portable evidence"]);

  assert.equal(adapter.metadata.provider, "openai-compatible");
  assert.equal(adapter.metadata.dimension, 3);
  assert.doesNotMatch(JSON.stringify(adapter.metadata), /private-provider-key/u);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.input,
    "https://embeddings.example.test/v1/embeddings",
  );
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>).authorization,
    "Bearer private-provider-key",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    dimensions: 3,
    input: ["Portable evidence"],
    model: "pilot-embedding-v1",
  });
});

test("treats an empty optional deployment credential as absent", async () => {
  const requests: RequestInit[] = [];
  const adapter = await createEmbeddingAdapter({
    environment: {
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_EMBEDDING_API_KEY: "",
      OPAS_EMBEDDING_DIMENSION: "3",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
    },
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      return Response.json({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      });
    },
  });

  await adapter.embed(["Portable evidence"]);

  assert.equal(requests.length, 1);
  assert.equal(
    new Headers(requests[0]?.headers).has("authorization"),
    false,
  );
});

test("rejects missing, malformed, and unsupported deployment configuration", async () => {
  await assert.rejects(
    createEmbeddingAdapter({
      environment: { OPAS_DATABASE_DRIVER: "d1" },
    }),
    /Workers AI embedding binding is unavailable/u,
  );
  await assert.rejects(
    createEmbeddingAdapter({
      environment: {
        OPAS_DATABASE_DRIVER: "postgres",
        OPAS_EMBEDDING_DIMENSION: "3.5",
        OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
        OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      },
    }),
    /dimension is invalid/u,
  );
  await assert.rejects(
    createEmbeddingAdapter({
      environment: {
        OPAS_DATABASE_DRIVER: "postgres",
        OPAS_EMBEDDING_DIMENSION: "4097",
        OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
        OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      },
    }),
    /dimension is outside the supported range/u,
  );
  await assert.rejects(
    createEmbeddingAdapter({
      environment: {
        OPAS_DATABASE_DRIVER: "neon",
        OPAS_EMBEDDING_DIMENSION: "3",
        OPAS_EMBEDDING_DIMENSIONS_PARAMETER: "sometimes",
        OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
        OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      },
    }),
    /dimensions parameter setting is invalid/u,
  );
  await assert.rejects(
    createEmbeddingAdapter({
      environment: {
        OPAS_DATABASE_DRIVER: "postgres",
        OPAS_EMBEDDING_API_KEY: " ",
        OPAS_EMBEDDING_DIMENSION: "3",
        OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
        OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      },
    }),
    /credential is invalid/u,
  );
  await assert.rejects(
    createEmbeddingAdapter({
      environment: { OPAS_DATABASE_DRIVER: "unknown" },
    }),
    /database driver is unsupported/u,
  );
});
