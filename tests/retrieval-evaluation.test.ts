// ABOUTME: Verifies the versioned synthetic retrieval fixture and portable benchmark reports.
// ABOUTME: Guards class counts, source hashes, recall, latency, memory, cost, and honest skipped targets.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyntheticRetrievalTarget,
  syntheticRetrievalFixtureV1,
  syntheticRetrievalSourceHashInputV1,
} from "@/evaluation/fixtures/synthetic-retrieval-v1";
import {
  configuredProviderRetrievalTargets,
  createAiSearchEvaluationTarget,
  createEmbeddingEvaluationTarget,
  createWorkersAiBenchmarkBinding,
} from "@/evaluation/provider-targets";
import {
  notConfiguredRetrievalTarget,
  runRetrievalEvaluation,
  type RetrievalEvaluationAdapter,
} from "@/evaluation/retrieval";
import { createOpenAiCompatibleEmbeddingAdapter } from "@/ai/embeddings";

const expectedClassCounts = {
  answerable: 20,
  ambiguous: 5,
  unsupported: 10,
  "stale-conflicting": 5,
  adversarial: 10,
} as const;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

test("synthetic fixture v1 contains the frozen 50-question class mix", () => {
  assert.equal(syntheticRetrievalFixtureV1.provenance, "synthetic");
  assert.equal(syntheticRetrievalFixtureV1.version, 1);
  assert.equal(syntheticRetrievalFixtureV1.questions.length, 50);

  const counts = Object.fromEntries(
    Object.keys(expectedClassCounts).map((classification) => [
      classification,
      syntheticRetrievalFixtureV1.questions.filter(
        (question) => question.classification === classification,
      ).length,
    ]),
  );
  assert.deepEqual(counts, expectedClassCounts);
  assert.equal(
    new Set(syntheticRetrievalFixtureV1.questions.map(({ id }) => id)).size,
    50,
  );
});

test("fixture hashes bind every accepted source to the versioned corpus", async () => {
  assert.equal(
    await sha256(syntheticRetrievalSourceHashInputV1),
    syntheticRetrievalFixtureV1.sourceContentHash,
  );
  const sources = new Map(
    syntheticRetrievalFixtureV1.sources.map((source) => [source.id, source]),
  );
  for (const source of sources.values()) {
    assert.equal(await sha256(source.evidenceText), source.contentHash, source.id);
  }
  for (const question of syntheticRetrievalFixtureV1.questions) {
    assert.deepEqual(
      question.sourceContentHashes,
      question.acceptedSourceIds.map((id) => sources.get(id)?.contentHash),
      question.id,
    );
  }
});

test("lexical and Orama hybrid evaluate the same synthetic fixture", async () => {
  const report = await runRetrievalEvaluation({
    fixture: syntheticRetrievalFixtureV1,
    targets: [
      createSyntheticRetrievalTarget(syntheticRetrievalFixtureV1, "lexical"),
      createSyntheticRetrievalTarget(syntheticRetrievalFixtureV1, "hybrid"),
    ],
    rebuildSamples: 2,
  });

  assert.equal(report.fixture.provenance, "synthetic");
  assert.equal(report.targets.length, 2);
  for (const target of report.targets) {
    assert.equal(target.status, "completed");
    if (target.status !== "completed") {
      continue;
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(target.perClass).map(([classification, result]) => [
          classification,
          result.denominator,
        ]),
      ),
      expectedClassCounts,
    );
    assert.equal(target.recallAt5.denominator, 20);
    assert.ok(target.recallAt5.rate >= 0.9, target.id);
    assert.equal(target.questions.length, 50);
    assert.ok(target.warmP95Ms >= 0);
    assert.equal(target.sourceEmbeddingP95Ms, null);
    assert.equal("activationP95Ms" in target, false);
    assert.ok((target.rebuildP95Ms ?? -1) >= 0);
    assert.equal(target.averageEvaluatedInferenceCostUsd, 0);
    assert.deepEqual(target.costCoverage, { numerator: 50, denominator: 50 });
  }
});

test("benchmark calculation reports deterministic p95, memory, cost, and class counts", async () => {
  let elapsed = 0;
  let memory = 1_000;
  const adapter: RetrievalEvaluationAdapter = {
    id: "timed-fixture",
    label: "Timed fixture",
    kind: "embedding-provider",
    provider: "fixture",
    model: "fixture-v1",
    async prepareSourceEmbeddings() {
      elapsed += 30;
      memory += 100;
    },
    async rebuild() {
      elapsed += 20;
      memory += 100;
    },
    async retrieve({ question }) {
      elapsed += 5;
      memory += 10;
      return {
        sourceIds: question.acceptedSourceIds.slice(0, 1),
        inferenceCostUsd: 0.001,
      };
    },
  };

  const report = await runRetrievalEvaluation({
    fixture: syntheticRetrievalFixtureV1,
    targets: [adapter],
    sourceEmbeddingSamples: 2,
    rebuildSamples: 3,
    now: () => elapsed,
    readMemoryBytes: () => memory,
    memoryMeasurement: "test-bytes",
  });
  const target = report.targets[0];
  assert.equal(target?.status, "completed");
  if (!target || target.status !== "completed") {
    return;
  }
  assert.equal(target.warmP95Ms, 5);
  assert.equal(target.sourceEmbeddingP95Ms, 30);
  assert.equal(target.rebuildP95Ms, 20);
  assert.equal(target.peakMemoryBytes, 2_000);
  assert.equal(target.memoryMeasurement, "test-bytes");
  assert.equal(target.averageEvaluatedInferenceCostUsd, 0.001);
  assert.deepEqual(target.costCoverage, { numerator: 50, denominator: 50 });
  assert.deepEqual(target.perClass.answerable, {
    numerator: 20,
    denominator: 20,
  });
  assert.deepEqual(target.perClass.unsupported, {
    numerator: 0,
    denominator: 10,
  });
});

test("real embedding adapters prepare source vectors and query the production hybrid path", async () => {
  const vectorsByInput = new Map<string, readonly number[]>([
    ...syntheticRetrievalFixtureV1.sources.map((source) => [
      `${source.title}\n\n${source.evidenceText}`,
      source.vector,
    ] as const),
    ...syntheticRetrievalFixtureV1.questions.map((question) => [
      question.question,
      question.queryVector,
    ] as const),
  ]);
  let requests = 0;
  const adapter = await createOpenAiCompatibleEmbeddingAdapter({
    apiKey: "private-test-key",
    dimension: syntheticRetrievalFixtureV1.sources[0]!.vector.length,
    endpoint: "https://embeddings.example.test/v1/embeddings",
    fetch: async (_input, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({
        data: body.input.map((input, index) => ({
          index,
          embedding: vectorsByInput.get(input),
        })),
      });
    },
    model: "fixture-provider-v1",
  });
  const target = createEmbeddingEvaluationTarget({
    adapter,
    cost: {
      cost: () => 0.001,
      description: "fixed test cost",
    },
    fixture: syntheticRetrievalFixtureV1,
    id: "provider-fixture",
    label: "Provider fixture",
  });

  const report = await runRetrievalEvaluation({
    fixture: syntheticRetrievalFixtureV1,
    targets: [target],
    sourceEmbeddingSamples: 1,
    rebuildSamples: 1,
  });
  const result = report.targets[0];
  assert.equal(result?.status, "completed");
  if (!result || result.status !== "completed") return;
  assert.equal(result.recallAt5.rate, 1);
  assert.ok((result.sourceEmbeddingP95Ms ?? -1) >= 0);
  assert.ok((result.rebuildP95Ms ?? -1) >= 0);
  assert.equal(result.averageEvaluatedInferenceCostUsd, 0.00128);
  assert.deepEqual(result.costCoverage, { numerator: 50, denominator: 50 });
  assert.equal(requests, 51);
});

test("Workers AI benchmark binding unwraps only the authenticated REST result", async () => {
  const vector = Array.from({ length: 768 }, () => 0.25);
  const binding = createWorkersAiBenchmarkBinding({
    accountId: "f8801c7e8853a113a25f8b52fd9ceec1",
    apiToken: "private-cloudflare-token",
    fetch: async (input, init) => {
      assert.equal(
        input,
        "https://api.cloudflare.com/client/v4/accounts/f8801c7e8853a113a25f8b52fd9ceec1/ai/run/@cf/baai/bge-base-en-v1.5",
      );
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      return Response.json({
        success: true,
        result: { data: [vector], pooling: "cls", shape: [1, 768] },
      });
    },
  });

  const result = await binding.run("@cf/baai/bge-base-en-v1.5", {
    text: ["reset password"],
    pooling: "cls",
  });
  assert.deepEqual(result, {
    data: [vector],
    pooling: "cls",
    shape: [1, 768],
  });
});

test("AI Search maps an exact staging fixture key set without accepting foreign chunks", async () => {
  const sourceKeys = Object.fromEntries(
    syntheticRetrievalFixtureV1.sources.map(({ id }) => [id, `${id}.md`]),
  );
  const question = syntheticRetrievalFixtureV1.questions[0]!;
  const sourceId = question.acceptedSourceIds[0]!;
  const target = createAiSearchEvaluationTarget({
    accountId: "f8801c7e8853a113a25f8b52fd9ceec1",
    apiToken: "private-cloudflare-token",
    costPerQueryUsd: 0.0002,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        ai_search_options: { retrieval: { max_num_results: number } };
        query: string;
      };
      assert.equal(body.query, question.question);
      assert.equal(body.ai_search_options.retrieval.max_num_results, 5);
      return Response.json({
        success: true,
        result: { chunks: [{ item: { key: sourceKeys[sourceId] } }] },
      });
    },
    instance: "opas-retrieval-evaluation",
    sourceKeys,
  });

  assert.deepEqual(await target.retrieve({ question, topK: 5 }), {
    sourceIds: [sourceId],
    inferenceCostUsd: 0.0002,
  });
});

test("provider target selection stays explicit when credentials are absent", async () => {
  const targets = await configuredProviderRetrievalTargets(
    syntheticRetrievalFixtureV1,
    {},
  );
  assert.deepEqual(
    targets.map((target) => ({ id: target.id, status: "status" in target ? target.status : "configured" })),
    [
      { id: "workers-ai", status: "not-configured" },
      { id: "openai-compatible", status: "not-configured" },
      { id: "cloudflare-ai-search", status: "not-configured" },
    ],
  );
});

test("unconfigured external targets are recorded without fabricated metrics", async () => {
  const report = await runRetrievalEvaluation({
    fixture: syntheticRetrievalFixtureV1,
    targets: [
      notConfiguredRetrievalTarget({
        id: "cloudflare-ai-search",
        label: "Cloudflare AI Search",
        kind: "ai-search",
        reason: "No staging index was configured for this run",
      }),
    ],
  });

  assert.deepEqual(report.targets, [
    {
      id: "cloudflare-ai-search",
      label: "Cloudflare AI Search",
      kind: "ai-search",
      status: "not-configured",
      reason: "No staging index was configured for this run",
    },
  ]);
});
