// ABOUTME: Verifies configured embedding recovery stays bounded and deployment-neutral.
// ABOUTME: Proves missing providers no-op and runtime output never reveals private failure details.
import assert from "node:assert/strict";
import test from "node:test";

import type { EmbeddingAdapter } from "@/ai/embeddings";
import {
  embeddingRuntimeFailureDetails,
  runConfiguredEmbeddingWorker,
} from "@/ai/embedding-runtime";
import { scheduleEmbeddingRecovery } from "@/ai/embedding-scheduling";
import type {
  EmbeddingWorkerRepository,
  EmbeddingWorkerResult,
} from "@/ai/embedding-worker";
import type { ArticleEvidenceInitializationRepository } from "@/content/article-evidence-initialization";

const privateValue = "private-provider-key-and-prompt";
const repository = {
  async listUnindexedPublishedArticles() {
    return [];
  },
  async initializeArticleEvidence() {
    return true;
  },
} as unknown as EmbeddingWorkerRepository & ArticleEvidenceInitializationRepository;
const adapter = {} as EmbeddingAdapter;

test("initializes evidence before disabled Postgres and Neon embedding recovery", async () => {
  let dependencyCalls = 0;

  for (const environment of [
    { OPAS_DATABASE_DRIVER: "postgres" },
    {
      OPAS_DATABASE_DRIVER: "neon",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
    },
  ]) {
    const result = await runConfiguredEmbeddingWorker({
      environment,
      createAdapter: async () => {
        dependencyCalls += 1;
        return adapter;
      },
      getRepository: async () => {
        dependencyCalls += 1;
        return repository;
      },
      runWorker: async () => {
        dependencyCalls += 1;
        throw new Error("worker should not run");
      },
    });

    assert.deepEqual(result, {
      status: "disabled",
      processedJobCount: 0,
      embeddedChunkCount: 0,
      activated: false,
    });
  }

  assert.equal(dependencyCalls, 2);
});

test("drains completed jobs until idle and returns only a redacted summary", async () => {
  const calls: string[] = [];
  const workerResult: EmbeddingWorkerResult = {
    status: "completed",
    generationId: `generation-${privateValue}`,
    jobId: `job-${privateValue}`,
    embeddedChunkCount: 7,
    activated: true,
  };

  let workerCalls = 0;
  const result = await runConfiguredEmbeddingWorker({
    environment: {
      OPAS_DATABASE_DRIVER: "neon",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      OPAS_EMBEDDING_DIMENSION: "3",
      OPAS_EMBEDDING_API_KEY: privateValue,
    },
    createAdapter: async () => {
      calls.push("adapter");
      return adapter;
    },
    createLeaseToken: () => "lease-token",
    getRepository: async () => {
      calls.push("repository");
      return repository;
    },
    runWorker: async (options) => {
      calls.push("worker");
      assert.equal(options.adapter, adapter);
      assert.equal(options.repository, repository);
      assert.equal(options.leaseToken, "lease-token");
      assert.equal(options.workspaceId, "workspace_demo");
      workerCalls += 1;
      return workerCalls === 1
        ? workerResult
        : {
            status: "idle",
            generationId: "generation-idle",
            embeddedChunkCount: 0,
            activated: false,
          };
    },
  });

  assert.deepEqual(calls, ["repository", "adapter", "worker", "worker"]);
  assert.deepEqual(result, {
    status: "idle",
    processedJobCount: 1,
    embeddedChunkCount: 7,
    activated: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-provider-key-and-prompt/u);
});

test("stops completed work at both the job and wall-clock budgets", async () => {
  let jobBoundCalls = 0;
  const jobBound = await runConfiguredEmbeddingWorker({
    environment: {
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      OPAS_EMBEDDING_DIMENSION: "3",
    },
    createAdapter: async () => adapter,
    getRepository: async () => repository,
    maximumJobs: 3,
    runtimeMilliseconds: () => 0,
    runWorker: async () => {
      jobBoundCalls += 1;
      return {
        status: "completed",
        generationId: "generation-budget",
        jobId: `job-${jobBoundCalls}`,
        embeddedChunkCount: 2,
        activated: false,
      };
    },
  });

  assert.deepEqual(jobBound, {
    status: "budget-exhausted",
    processedJobCount: 3,
    embeddedChunkCount: 6,
    activated: false,
  });

  const times = [0, 0, 250];
  let wallBoundCalls = 0;
  const wallBound = await runConfiguredEmbeddingWorker({
    environment: {
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      OPAS_EMBEDDING_DIMENSION: "3",
    },
    createAdapter: async () => adapter,
    getRepository: async () => repository,
    maximumRuntimeMilliseconds: 200,
    runtimeMilliseconds: () => times.shift() ?? 250,
    runWorker: async () => {
      wallBoundCalls += 1;
      return {
        status: "completed",
        generationId: "generation-budget",
        jobId: "job-wall-budget",
        embeddedChunkCount: 1,
        activated: false,
      };
    },
  });

  assert.equal(wallBoundCalls, 1);
  assert.deepEqual(wallBound, {
    status: "budget-exhausted",
    processedJobCount: 1,
    embeddedChunkCount: 1,
    activated: false,
  });
});

test("counts completed work against the job budget without exposing job identifiers", async () => {
  let workerCalls = 0;
  const result = await runConfiguredEmbeddingWorker({
    environment: {
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_EMBEDDING_ENDPOINT: "https://embeddings.example.test/v1/embeddings",
      OPAS_EMBEDDING_MODEL: "pilot-embedding-v1",
      OPAS_EMBEDDING_DIMENSION: "3",
    },
    createAdapter: async () => adapter,
    getRepository: async () => repository,
    maximumJobs: 2,
    runtimeMilliseconds: () => 0,
    runWorker: async () => {
      workerCalls += 1;
      if (workerCalls > 2) {
        throw new Error("Embedding recovery exceeded its job budget");
      }

      return {
        status: "completed",
        generationId: "generation-without-job-id",
        embeddedChunkCount: 1,
        activated: false,
      };
    },
  });

  assert.equal(workerCalls, 2);
  assert.deepEqual(result, {
    status: "budget-exhausted",
    processedJobCount: 2,
    embeddedChunkCount: 2,
    activated: false,
  });
});

test("passes the D1 Workers AI binding into the fixed Cloudflare adapter", async () => {
  const workersAiBinding = { run: async () => ({}) } as never;
  let receivedBinding: unknown;

  const result = await runConfiguredEmbeddingWorker({
    environment: { OPAS_DATABASE_DRIVER: "d1" },
    workersAiBinding,
    createAdapter: async (configuration) => {
      receivedBinding = configuration?.workersAiBinding;
      return adapter;
    },
    getRepository: async () => repository,
    runWorker: async () => ({
      status: "idle",
      generationId: "generation-cloudflare",
      embeddedChunkCount: 0,
      activated: false,
    }),
  });

  assert.equal(receivedBinding, workersAiBinding);
  assert.deepEqual(result, {
    status: "idle",
    processedJobCount: 0,
    embeddedChunkCount: 0,
    activated: false,
  });
});

test("reduces thrown errors to a non-sensitive type", () => {
  const error = Object.assign(new Error(privateValue), {
    code: "ECONNRESET",
    requestBody: privateValue,
  });
  const details = embeddingRuntimeFailureDetails(error);

  assert.deepEqual(details, { type: "Error" });
  assert.doesNotMatch(JSON.stringify(details), /private-provider-key-and-prompt/u);
  assert.deepEqual(embeddingRuntimeFailureDetails(privateValue), {
    type: "UnknownError",
  });
});

test("post-commit scheduling never delays the mutation and contains failures", async () => {
  let scheduled: (() => Promise<void>) | undefined;
  const reported: unknown[] = [];
  let recoveryCalls = 0;

  scheduleEmbeddingRecovery({
    schedule(callback) {
      scheduled = async () => {
        await callback();
      };
    },
    recover: async () => {
      recoveryCalls += 1;
      throw new Error(privateValue);
    },
    reportFailure(details) {
      reported.push(details);
    },
  });

  assert.equal(recoveryCalls, 0);
  assert.ok(scheduled);
  await scheduled();
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(reported, [{ type: "Error" }]);
  assert.doesNotMatch(JSON.stringify(reported), /private-provider-key-and-prompt/u);
});
