// ABOUTME: Verifies grounded answer runtime wiring across retrieval and query embeddings.
// ABOUTME: Proves exact active metadata gates hybrid mode while lexical answers stay available.
import assert from "node:assert/strict";
import test from "node:test";

import type { EmbeddingAdapter, EmbeddingMetadata } from "@/ai/embeddings";
import type {
  GenerationAdapter,
  GenerationEvent,
  GenerationRequest,
} from "@/ai/generation";
import {
  answerEvidencePolicy,
  answerEvidencePolicyCalibration,
  createConfiguredAnswerRuntime,
} from "@/answers/answer-runtime";
import type {
  ActiveChunkEmbedding,
  EmbeddingGeneration,
  EvidenceCandidateIdentity,
  EvidenceChunkRecord,
  Repository,
} from "@/db/repository";

const workspaceId = "workspace_demo";
const articleHash = "a".repeat(64);
const chunkHash = "b".repeat(64);
const embeddingInputHash = "c".repeat(64);

function generationAdapter(onRequest?: (request: GenerationRequest) => void) {
  const adapter: GenerationAdapter = {
    limits: {
      maximumInputUtf8Bytes: 65_536,
      maximumMessages: 16,
      maximumOutputTokens: 1_024,
      maximumOutputUtf8Bytes: 65_536,
      timeoutMilliseconds: 30_000,
    },
    metadata: Object.freeze({
      model: "fixture-answer-v1",
      provider: "openai-compatible" as const,
      retentionDisclosure: "Fixture requests are not retained.",
    }),
    stream(request) {
      onRequest?.(request);
      return (async function* (): AsyncIterable<GenerationEvent> {
        yield {
          text:
            '{"type":"content","markdown":"Open **Account settings**."}\n' +
            '{"type":"citation","id":"C1"}\n',
          type: "text",
        };
        yield {
          reason: "stop",
          type: "finish",
          usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        };
      })();
    },
  };
  return adapter;
}

function embeddingMetadata(
  overrides: Partial<EmbeddingMetadata> = {},
): EmbeddingMetadata {
  return {
    provider: "openai-compatible",
    model: "fixture-embedding-v1",
    dimension: 3,
    configuration: {
      dimensionsParameter: false,
      endpoint: "https://embeddings.example.test/v1/embeddings",
    },
    configurationHash: "d".repeat(64),
    ...overrides,
  } as EmbeddingMetadata;
}

function embeddingAdapter(
  metadata: EmbeddingMetadata,
  embed: EmbeddingAdapter["embed"],
): EmbeddingAdapter {
  return {
    limits: {
      maximumBatchInputUtf8Bytes: 8_192,
      maximumBatchSize: 1,
      maximumInputUtf8Bytes: 8_192,
    },
    metadata,
    embed,
  };
}

function activeGeneration(
  metadata: EmbeddingMetadata,
  overrides: Partial<EmbeddingGeneration> = {},
): EmbeddingGeneration {
  return {
    id: "embedding-generation-active",
    workspaceId,
    provider: metadata.provider,
    model: metadata.model,
    dimension: metadata.dimension,
    configurationHash: metadata.configurationHash,
    status: "active",
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    activatedAt: new Date("2026-08-30T00:01:00.000Z"),
    retiredAt: null,
    ...overrides,
  };
}

function evidenceChunk(): EvidenceChunkRecord {
  return {
    id: "chunk-password-reset",
    workspaceId,
    articleId: "article-password-reset",
    articleContentHash: articleHash,
    contentHash: chunkHash,
    embeddingInputHash,
    indexGeneration: 7,
    publicationState: "published",
    ordinal: 0,
    title: "Reset your password",
    headingPath: ["Account", "Password"],
    canonicalUrl: "https://help.example.test/account/reset-password",
    markdown:
      "## Reset your password\n\nReset password from Account settings. Reset password links expire after one hour.",
    evidenceText:
      "Reset password from Account settings. Reset password links expire after one hour.",
    embeddingText:
      "Reset your password Account Password Reset password from Account settings.",
    sourceLineRange: { start: 3, end: 5 },
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  };
}

function activeEmbedding(metadata: EmbeddingMetadata): ActiveChunkEmbedding {
  return {
    workspaceId,
    chunkId: "chunk-password-reset",
    articleId: "article-password-reset",
    contentHash: chunkHash,
    embeddingInputHash,
    embeddingGenerationId: "embedding-generation-active",
    provider: metadata.provider,
    model: metadata.model,
    dimension: metadata.dimension,
    configurationHash: metadata.configurationHash,
    vector: [1, 0, 0],
  };
}

function repositoryFixture({
  metadata,
  revalidate = (candidates: readonly EvidenceCandidateIdentity[]) => candidates,
  generation = activeGeneration(metadata),
}: {
  metadata: EmbeddingMetadata;
  revalidate?: (
    candidates: readonly EvidenceCandidateIdentity[],
  ) => readonly EvidenceCandidateIdentity[];
  generation?: EmbeddingGeneration | null;
}) {
  const revalidationCalls: readonly EvidenceCandidateIdentity[][] = [];
  const calls = revalidationCalls as EvidenceCandidateIdentity[][];
  const repository = {
    async getActiveEmbeddingGeneration() {
      return generation;
    },
    async getIndexingState() {
      return {
        workspaceId,
        generation: 7,
        activeEmbeddingGenerationId: generation?.id ?? null,
        updatedAt: new Date("2026-08-30T00:01:00.000Z"),
      };
    },
    async listEvidenceChunks() {
      return [evidenceChunk()];
    },
    async listActiveChunkEmbeddings() {
      return generation ? [activeEmbedding(metadata)] : [];
    },
    async revalidateEvidenceCandidates(request: {
      candidates: readonly EvidenceCandidateIdentity[];
    }) {
      calls.push([...request.candidates]);
      return revalidate(request.candidates);
    },
  } as unknown as Repository;
  return { repository, revalidationCalls };
}

async function collect(runtime: Awaited<ReturnType<typeof createConfiguredAnswerRuntime>>) {
  const events = [];
  for await (const event of runtime.service.stream({
    question: "How do I reset my password?",
    workspaceId,
  })) {
    events.push(event);
  }
  return events;
}

test("uses hybrid retrieval only for an exact active embedding generation", async () => {
  const metadata = embeddingMetadata();
  const { repository, revalidationCalls } = repositoryFixture({ metadata });
  const embedded: string[][] = [];
  const runtime = await createConfiguredAnswerRuntime({
    environment: { OPAS_DATABASE_DRIVER: "neon" },
    createEmbeddingAdapter: async () =>
      embeddingAdapter(metadata, async (input) => {
        embedded.push([...input]);
        return { metadata, vectors: [[1, 0, 0]] };
      }),
    createGenerationAdapter: () => generationAdapter(),
    getRepository: async () => repository,
  });

  const events = await collect(runtime);

  assert.deepEqual(embedded, [["How do I reset my password?"]]);
  assert.equal(revalidationCalls.length, 1);
  assert.equal(events[0]?.type, "content");
  assert.equal(events[1]?.type, "citation");
  assert.deepEqual(runtime.metadata, {
    model: "fixture-answer-v1",
    provider: "openai-compatible",
    retentionDisclosure: "Fixture requests are not retained.",
  });
  assert.ok(Object.isFrozen(runtime.metadata));
});

test("falls back to lexical retrieval for metadata mismatch and provider failure", async (context) => {
  const metadata = embeddingMetadata();
  for (const fixture of [
    {
      name: "metadata mismatch",
      generation: activeGeneration(metadata, { model: "different-model" }),
      embed: async () => {
        throw new Error("embedding must not run");
      },
      expectedEmbedCalls: 0,
    },
    {
      name: "query provider failure",
      generation: activeGeneration(metadata),
      embed: async () => {
        throw new Error("private provider request and credential");
      },
      expectedEmbedCalls: 1,
    },
  ] as const) {
    await context.test(fixture.name, async () => {
      let embedCalls = 0;
      const { repository } = repositoryFixture({
        metadata,
        generation: fixture.generation,
      });
      const runtime = await createConfiguredAnswerRuntime({
        environment: { OPAS_DATABASE_DRIVER: "postgres" },
        createEmbeddingAdapter: async () =>
          embeddingAdapter(metadata, async () => {
            embedCalls += 1;
            return fixture.embed() as never;
          }),
        createGenerationAdapter: () => generationAdapter(),
        getRepository: async () => repository,
      });

      const events = await collect(runtime);

      assert.equal(embedCalls, fixture.expectedEmbedCalls);
      assert.equal(events[0]?.type, "content");
      assert.equal(events[1]?.type, "citation");
    });
  }
});

test("final repository revalidation can only produce abstention, never a stale citation", async () => {
  const metadata = embeddingMetadata();
  let generationCalls = 0;
  const { repository, revalidationCalls } = repositoryFixture({
    metadata,
    revalidate: () => [],
  });
  const runtime = await createConfiguredAnswerRuntime({
    environment: { OPAS_DATABASE_DRIVER: "d1" },
    workersAiBinding: { run: async () => ({}) } as never,
    createEmbeddingAdapter: async () =>
      embeddingAdapter(metadata, async () => ({
        metadata,
        vectors: [[1, 0, 0]],
      })),
    createGenerationAdapter: () =>
      generationAdapter(() => {
        generationCalls += 1;
      }),
    getRepository: async () => repository,
  });

  const events = await collect(runtime);

  assert.equal(revalidationCalls.length, 1);
  assert.equal(generationCalls, 0);
  assert.deepEqual(events, [
    {
      message: "I couldn’t find enough published information to answer that.",
      reason: "insufficient-evidence",
      type: "abstention",
    },
  ]);
});

test("cancellation interrupts retrieval before evidence loading or generation", async () => {
  const metadata = embeddingMetadata();
  let markActiveRead: () => void = () => {};
  const activeRead = new Promise<void>((resolve) => {
    markActiveRead = resolve;
  });
  let evidenceReads = 0;
  let generationCalls = 0;
  const repository = {
    async getActiveEmbeddingGeneration() {
      markActiveRead();
      return new Promise<EmbeddingGeneration>(() => {});
    },
    async getIndexingState() {
      evidenceReads += 1;
      return null;
    },
    async listEvidenceChunks() {
      evidenceReads += 1;
      return [];
    },
    async listActiveChunkEmbeddings() {
      evidenceReads += 1;
      return [];
    },
    async revalidateEvidenceCandidates() {
      evidenceReads += 1;
      return [];
    },
  } as unknown as Repository;
  const runtime = await createConfiguredAnswerRuntime({
    environment: { OPAS_DATABASE_DRIVER: "postgres" },
    createEmbeddingAdapter: async () =>
      embeddingAdapter(metadata, async () => ({
        metadata,
        vectors: [[1, 0, 0]],
      })),
    createGenerationAdapter: () =>
      generationAdapter(() => {
        generationCalls += 1;
      }),
    getRepository: async () => repository,
  });
  const controller = new AbortController();
  const answer = runtime.service
    .stream({
      question: "How do I reset my password?",
      signal: controller.signal,
      workspaceId,
    })
    [Symbol.asyncIterator]()
    .next();

  await activeRead;
  controller.abort();

  await assert.rejects(answer, /cancelled/u);
  assert.equal(evidenceReads, 0);
  assert.equal(generationCalls, 0);
});

test("publishes the fixed synthetic-v1 sufficiency policy", () => {
  assert.deepEqual(answerEvidencePolicy, {
    minimumScore: 0.7,
    minimumScoreGapAcrossArticles: 0.07,
  });
  assert.ok(Object.isFrozen(answerEvidencePolicy));
  assert.deepEqual(answerEvidencePolicyCalibration, {
    fixtureId: "synthetic_retrieval_v1",
    sourceContentHash:
      "4297d85a9c014d8f8a2f2fc275091bdc31af84ef6220c5d01e5b67ac3c5eb712",
    provenance: "synthetic",
    requiredAnswerScoreFloor: 1,
    unsupportedScoreCeiling: 0.5,
    minimumScoreMidpoint: 0.75,
    minimumScoreRounding: "down-to-one-decimal",
    conflictingArticleGapCeiling: 0.064479,
    conflictingArticleGapRounding: "up-to-two-decimals",
    designPartnerCalibration: "pending",
  });
  assert.ok(Object.isFrozen(answerEvidencePolicyCalibration));
});
