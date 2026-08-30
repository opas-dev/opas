// ABOUTME: Verifies provider-neutral embedding work, retries, leases, and activation boundaries.
// ABOUTME: Proves unchanged evidence is skipped and persisted vectors stay within portable byte limits.
import assert from "node:assert/strict";
import test from "node:test";

import {
  EmbeddingError,
  type EmbeddingAdapter,
  type EmbeddingMetadata,
} from "@/ai/embeddings";
import {
  embeddingPersistenceMaximumUtf8Bytes,
  runEmbeddingWorker,
  type EmbeddingWorkerRepository,
  type EmbeddingWorkerWork,
} from "@/ai/embedding-worker";

const configurationHash = "a".repeat(64);
const contentHash = "b".repeat(64);
const embeddingInputHash = "c".repeat(64);
const startedAt = new Date("2026-08-30T12:00:00.000Z");

const metadata: EmbeddingMetadata = {
  provider: "openai-compatible",
  model: "pilot-embedding-v1",
  dimension: 3,
  configuration: {
    dimensionsParameter: false,
    endpoint: "https://embeddings.example.test/v1/embeddings",
  },
  configurationHash,
};

function adapter(
  embed: EmbeddingAdapter["embed"],
  overrides: Partial<EmbeddingAdapter> = {},
): EmbeddingAdapter {
  return {
    metadata,
    limits: {
      maximumBatchInputUtf8Bytes: 16_384,
      maximumBatchSize: 32,
      maximumInputUtf8Bytes: 4_096,
    },
    embed,
    ...overrides,
  };
}

function work(
  overrides: Partial<EmbeddingWorkerWork> = {},
): EmbeddingWorkerWork {
  return {
    job: {
      id: "embedding_job_pilot",
      attempts: 1,
      maximumAttempts: 3,
      embeddingGenerationId: "embedding_generation_pilot",
    },
    generation: {
      id: "embedding_generation_pilot",
      workspaceId: "workspace_demo",
      provider: metadata.provider,
      model: metadata.model,
      dimension: metadata.dimension,
      configurationHash: metadata.configurationHash,
      status: "building",
    },
    chunks: [
      {
        id: "chunk_changed",
        contentHash,
        embeddingInputHash,
        embeddingText: "Changed published evidence",
      },
    ],
    completedChunkCount: 1,
    totalChunkCount: 2,
    ...overrides,
  };
}

type RepositoryCalls = {
  activated: number;
  checkpoints: Array<{ completedChunkCount: number; leaseExpiresAt: Date }>;
  completed: number;
  failed: string[];
  retries: Array<{ availableAt: Date; errorCode: string }>;
  saved: Array<readonly unknown[]>;
};

function repository(
  works: Array<EmbeddingWorkerWork | null>,
  overrides: Partial<EmbeddingWorkerRepository> = {},
) {
  const calls: RepositoryCalls = {
    activated: 0,
    checkpoints: [],
    completed: 0,
    failed: [],
    retries: [],
    saved: [],
  };
  let workIndex = 0;
  const value: EmbeddingWorkerRepository = {
    async reconcileEmbeddingGeneration(input) {
      return {
        id: "embedding_generation_pilot",
        workspaceId: input.workspaceId,
        provider: input.metadata.provider,
        model: input.metadata.model,
        dimension: input.metadata.dimension,
        configurationHash: input.metadata.configurationHash,
        status: "building",
      };
    },
    async claimEmbeddingJob() {
      return {
        id: "embedding_job_pilot",
        attempts: 1,
        maximumAttempts: 3,
        embeddingGenerationId: "embedding_generation_pilot",
      };
    },
    async getEmbeddingJobWork() {
      const result = works[Math.min(workIndex, works.length - 1)] ?? null;
      workIndex += 1;
      return result;
    },
    async saveEmbeddingJobBatch(input) {
      calls.saved.push(input.embeddings);
      return true;
    },
    async checkpointEmbeddingJob(input) {
      calls.checkpoints.push({
        completedChunkCount: input.completedChunkCount,
        leaseExpiresAt: input.leaseExpiresAt,
      });
      return true;
    },
    async completeEmbeddingJob() {
      calls.completed += 1;
      return true;
    },
    async retryEmbeddingJob(input) {
      calls.retries.push({
        availableAt: input.availableAt,
        errorCode: input.errorCode,
      });
      return true;
    },
    async failEmbeddingJob(input) {
      calls.failed.push(input.errorCode);
      return true;
    },
    async activateEmbeddingGeneration() {
      calls.activated += 1;
      return true;
    },
    ...overrides,
  };
  return { calls, repository: value };
}

test("embeds only missing exact chunks, checkpoints, completes, and activates", async () => {
  let providerCalls = 0;
  const { calls, repository: evidence } = repository([
    work(),
    work({ chunks: [], completedChunkCount: 2 }),
  ]);

  const result = await runEmbeddingWorker({
    adapter: adapter(async (input) => {
      providerCalls += 1;
      return { metadata, vectors: input.map(() => [0.1, 0.2, 0.3]) };
    }),
    clock: () => startedAt,
    leaseToken: "lease_pilot",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.embeddedChunkCount, 1);
  assert.equal(result.activated, true);
  assert.equal(providerCalls, 1);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.checkpoints[0]?.completedChunkCount, 2);
  assert.equal(calls.completed, 1);
  assert.equal(calls.activated, 1);
});

test("completes an unchanged revision without recomputing its chunks", async () => {
  let providerCalls = 0;
  const { calls, repository: evidence } = repository([
    work({ chunks: [], completedChunkCount: 2 }),
  ]);

  const result = await runEmbeddingWorker({
    adapter: adapter(async () => {
      providerCalls += 1;
      return { metadata, vectors: [] };
    }),
    clock: () => startedAt,
    leaseToken: "lease_unchanged",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.embeddedChunkCount, 0);
  assert.equal(providerCalls, 0);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.completed, 1);
});

test("schedules bounded retry for retryable provider failure", async () => {
  const { calls, repository: evidence } = repository([work()]);
  const result = await runEmbeddingWorker({
    adapter: adapter(async () => {
      throw new EmbeddingError("rate-limited", "sensitive provider response");
    }),
    clock: () => startedAt,
    leaseToken: "lease_retry",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.equal(result.status, "retry-scheduled");
  assert.deepEqual(calls.failed, []);
  assert.deepEqual(calls.retries, [
    {
      availableAt: new Date(startedAt.getTime() + 5_000),
      errorCode: "rate-limited",
    },
  ]);
  assert.equal(calls.activated, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive provider response/u);
});

test("fails a retryable provider error after the bounded attempt limit", async () => {
  const { calls, repository: evidence } = repository([work()], {
    async claimEmbeddingJob() {
      return {
        id: "embedding_job_pilot",
        attempts: 3,
        maximumAttempts: 3,
        embeddingGenerationId: "embedding_generation_pilot",
      };
    },
  });
  const result = await runEmbeddingWorker({
    adapter: adapter(async () => {
      throw new EmbeddingError("timeout", "sensitive provider response");
    }),
    clock: () => startedAt,
    leaseToken: "lease_attempt_limit",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(calls.retries, []);
  assert.deepEqual(calls.failed, ["timeout"]);
  assert.equal(calls.activated, 0);
});

test("fails non-retryable response mismatch without storing vectors", async () => {
  const { calls, repository: evidence } = repository([work()]);
  const mismatchedMetadata: EmbeddingMetadata = {
    ...metadata,
    configurationHash: "d".repeat(64),
  };
  const result = await runEmbeddingWorker({
    adapter: adapter(async () => ({
      metadata: mismatchedMetadata,
      vectors: [[0.1, 0.2, 0.3]],
    })),
    clock: () => startedAt,
    leaseToken: "lease_mismatch",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(calls.failed, ["invalid-response"]);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.completed, 0);
});

test("stops without terminal mutation after losing the lease during persistence", async () => {
  const { calls, repository: evidence } = repository([work()], {
    async saveEmbeddingJobBatch() {
      return false;
    },
  });
  const result = await runEmbeddingWorker({
    adapter: adapter(async () => ({
      metadata,
      vectors: [[0.1, 0.2, 0.3]],
    })),
    clock: () => startedAt,
    leaseToken: "lease_lost",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.equal(result.status, "lost-lease");
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(calls.completed, 0);
  assert.equal(calls.retries.length, 0);
  assert.equal(calls.failed.length, 0);
});

test("splits high-dimensional provider output below the portable persistence byte bound", async () => {
  const largeMetadata: EmbeddingMetadata = {
    ...metadata,
    dimension: 4_096,
  };
  const chunks = Array.from({ length: 24 }, (_, index) => ({
    id: `chunk_large_${index}`,
    contentHash: index.toString(16).padStart(64, "0"),
    embeddingInputHash: (index + 24).toString(16).padStart(64, "0"),
    embeddingText: `Large vector evidence ${index}`,
  }));
  const initialWork = work({
    chunks,
    completedChunkCount: 0,
    totalChunkCount: chunks.length,
    generation: {
      ...work().generation,
      dimension: largeMetadata.dimension,
    },
  });
  const { calls, repository: evidence } = repository([
    initialWork,
    { ...initialWork, chunks: [], completedChunkCount: chunks.length },
  ]);

  await runEmbeddingWorker({
    adapter: adapter(
      async (input) => ({
        metadata: largeMetadata,
        vectors: input.map(() =>
          Array.from({ length: largeMetadata.dimension }, () => Number.MAX_VALUE),
        ),
      }),
      { metadata: largeMetadata },
    ),
    clock: () => startedAt,
    leaseToken: "lease_large",
    repository: evidence,
    workspaceId: "workspace_demo",
  });

  assert.ok(calls.saved.length > 1);
  for (const batch of calls.saved) {
    assert.ok(
      new TextEncoder().encode(JSON.stringify(batch)).byteLength <=
        embeddingPersistenceMaximumUtf8Bytes,
    );
  }
  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.checkpoints[0]?.completedChunkCount, chunks.length);
});
