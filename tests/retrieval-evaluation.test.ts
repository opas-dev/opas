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
  notConfiguredRetrievalTarget,
  runRetrievalEvaluation,
  type RetrievalEvaluationAdapter,
} from "@/evaluation/retrieval";

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
  assert.equal(target.rebuildP95Ms, 20);
  assert.equal(target.peakMemoryBytes, 1_800);
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
