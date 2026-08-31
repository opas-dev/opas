// ABOUTME: Verifies grounded answer runtime wiring across retrieval and query embeddings.
// ABOUTME: Proves exact active metadata gates hybrid mode while lexical answers stay available.
import assert from "node:assert/strict";
import test from "node:test";

import type { EmbeddingAdapter, EmbeddingMetadata } from "@/ai/embeddings";
import {
  createGenerationFallbackAdapter,
  GenerationError,
  type GenerationAdapter,
  type GenerationEvent,
  type GenerationRequest,
} from "@/ai/generation";
import {
  answerEvidencePolicy,
  answerEvidencePolicyCalibration,
  createConfiguredAnswerRuntime,
  createConfiguredRetainedAnswerRuntime,
} from "@/answers/answer-runtime";
import { AnswerAdmissionError } from "@/answers/admission";
import type {
  ActiveChunkEmbedding,
  AnswerInferenceLease,
  AnswerInferenceReconciliation,
  AnswerInferenceRepository,
  AnswerInferenceReservation,
  EmbeddingGeneration,
  EvidenceCandidateIdentity,
  EvidenceChunkRecord,
  Repository,
} from "@/db/repository";
import type { EvidenceRetrievalResult } from "@/search/evidence";

const workspaceId = "workspace_demo";
const articleHash = "a".repeat(64);
const chunkHash = "b".repeat(64);
const embeddingInputHash = "c".repeat(64);
const answerAdmissionEnvironment = {
  OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS: "1000000",
  OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "152000",
  OPAS_ANSWER_LEASE_MILLISECONDS: "45000",
  OPAS_ANSWER_MAXIMUM_CONCURRENCY: "4",
  OPAS_ANSWER_MAXIMUM_INPUT_TOKENS: "32000",
  OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "287000",
} as const;

function answerInferenceRepository(observations?: {
  accepted?: boolean;
  reconciliations: AnswerInferenceReconciliation[];
  reservations: AnswerInferenceReservation[];
}): AnswerInferenceRepository {
  let lease: AnswerInferenceLease | null = null;
  return {
    async reserveAnswerInference(reservation: AnswerInferenceReservation) {
      observations?.reservations.push(reservation);
      if (observations?.accepted === false) return null;
      lease = {
        id: reservation.id,
        workspaceId: reservation.workspaceId,
        provider: reservation.provider,
        model: reservation.model,
        maximumOutputTokens: reservation.maximumOutputTokens,
        reservedMicrodollars: reservation.reservedMicrodollars,
        chargedMicrodollars: null,
        status: "active",
        inputTokens: null,
        outputTokens: null,
        startedAt: reservation.startedAt,
        expiresAt: reservation.expiresAt,
        reconciledAt: null,
      };
      return lease;
    },
    async reconcileAnswerInference(
      reconciliation: AnswerInferenceReconciliation,
    ) {
      observations?.reconciliations.push(reconciliation);
      if (!lease) return null;
      lease = { ...lease, ...reconciliation };
      return lease;
    },
    async getAnswerInferenceLease() {
      return lease;
    },
  };
}

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
          text: "ANSWER A\nOpen **Account settings**.",
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

function retainedEvidenceSnapshot() {
  return Object.freeze([
    Object.freeze({
      articleContentHash: articleHash,
      articleId: "article-retained",
      canonicalUrl: "https://help.example.test/retained",
      chunkId: "chunk-retained",
      contentHash: chunkHash,
      evidenceText: "Retained redacted snapshot only. [REDACTED]",
      headingPath: Object.freeze(["Retained section"]),
      indexGeneration: 3,
      markdown: "Retained redacted snapshot only. [REDACTED]",
      mode: "lexical" as const,
      ordinal: 0,
      score: 0.91,
      sourceId: "chunk-retained",
      sourceLineRange: Object.freeze({ end: 4, start: 3 }),
      title: "Retained source",
      workspaceId,
    }),
  ]) satisfies readonly EvidenceRetrievalResult[];
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
    ...answerInferenceRepository(),
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
    environment: {
      ...answerAdmissionEnvironment,
      OPAS_DATABASE_DRIVER: "neon",
    },
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

test("uses retained evidence under one atomic inference lease without repository retrieval", async () => {
  const reservations: AnswerInferenceReservation[] = [];
  const reconciliations: AnswerInferenceReconciliation[] = [];
  let repositoryRetrievalCalls = 0;
  const rejectRepositoryRetrieval = async () => {
    repositoryRetrievalCalls += 1;
    throw new Error("Retained replay must not retrieve current repository evidence");
  };
  const repository = {
    ...answerInferenceRepository({ reconciliations, reservations }),
    getActiveEmbeddingGeneration: rejectRepositoryRetrieval,
    getIndexingState: rejectRepositoryRetrieval,
    listActiveChunkEmbeddings: rejectRepositoryRetrieval,
    listEvidenceChunks: rejectRepositoryRetrieval,
    revalidateEvidenceCandidates: rejectRepositoryRetrieval,
  } as unknown as Repository;
  let generationCalls = 0;
  const runtime = await createConfiguredRetainedAnswerRuntime(
    retainedEvidenceSnapshot(),
    {
      environment: {
        ...answerAdmissionEnvironment,
        OPAS_DATABASE_DRIVER: "postgres",
      },
      createGenerationAdapter: () =>
        generationAdapter((request) => {
          generationCalls += 1;
          const prompt = request.messages
            .map(({ content }) => content)
            .join("\n");
          assert.match(prompt, /Retained redacted snapshot only\. \[REDACTED\]/u);
          assert.doesNotMatch(prompt, /Reset password links expire/u);
        }),
      getRepository: async () => repository,
    },
  );
  const events = [];
  for await (const event of runtime.service.stream({
    question: "What did the retained source say?",
    workspaceId,
  })) {
    events.push(event);
  }

  assert.equal(generationCalls, 1);
  assert.equal(repositoryRetrievalCalls, 0);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0]?.workspaceId, workspaceId);
  assert.equal(reservations[0]?.provider, "openai-compatible");
  assert.equal(reservations[0]?.model, "fixture-answer-v1");
  assert.equal(reservations[0]?.maximumOutputTokens, 512);
  assert.equal(reservations[0]?.maximumConcurrency, 4);
  assert.equal(reservations[0]?.dailyBudgetMicrodollars, 1_000_000);
  assert.equal(reservations[0]?.reservedMicrodollars, 5_011);
  assert.equal(
    reservations[0]!.expiresAt.getTime() - reservations[0]!.startedAt.getTime(),
    45_000,
  );
  assert.equal(
    reservations[0]!.startedAt.getTime() -
      reservations[0]!.spendWindowStartedAt.getTime(),
    24 * 60 * 60 * 1_000,
  );
  assert.equal(reconciliations.length, 1);
  assert.deepEqual(
    {
      chargedMicrodollars: reconciliations[0]?.chargedMicrodollars,
      id: reconciliations[0]?.id,
      inputTokens: reconciliations[0]?.inputTokens,
      outputTokens: reconciliations[0]?.outputTokens,
      status: reconciliations[0]?.status,
      workspaceId: reconciliations[0]?.workspaceId,
    },
    {
      chargedMicrodollars: 7,
      id: reservations[0]?.id,
      inputTokens: 20,
      outputTokens: 8,
      status: "completed",
      workspaceId,
    },
  );
  assert.equal(events[0]?.type, "content");
  assert.deepEqual(
    events[1]?.type === "citation" ? events[1].citation.sourceId : null,
    "chunk-retained",
  );
});

test("retained evidence honors durable admission denial before provider inference", async () => {
  const reservations: AnswerInferenceReservation[] = [];
  const reconciliations: AnswerInferenceReconciliation[] = [];
  let generationCalls = 0;
  const repository = answerInferenceRepository({
    accepted: false,
    reconciliations,
    reservations,
  }) as unknown as Repository;
  const runtime = await createConfiguredRetainedAnswerRuntime(
    retainedEvidenceSnapshot(),
    {
      environment: {
        ...answerAdmissionEnvironment,
        OPAS_DATABASE_DRIVER: "postgres",
      },
      createGenerationAdapter: () =>
        generationAdapter(() => {
          generationCalls += 1;
        }),
      getRepository: async () => repository,
    },
  );

  await assert.rejects(
    async () => {
      for await (const event of runtime.service.stream({
        question: "What did the retained source say?",
        workspaceId,
      })) {
        void event;
        // Admission denial must end the stream before a provider event exists.
      }
    },
    (error: unknown) =>
      error instanceof AnswerAdmissionError && error.category === "denied",
  );
  assert.equal(reservations.length, 1);
  assert.equal(reconciliations.length, 0);
  assert.equal(generationCalls, 0);
});

test("retained evidence reconciles a failed provider attempt exactly once", async () => {
  const reservations: AnswerInferenceReservation[] = [];
  const reconciliations: AnswerInferenceReconciliation[] = [];
  const repository = answerInferenceRepository({
    reconciliations,
    reservations,
  }) as unknown as Repository;
  const failure = new GenerationError(
    "provider-unavailable",
    "Fixture provider unavailable",
  );
  const generation = generationAdapter();
  const runtime = await createConfiguredRetainedAnswerRuntime(
    retainedEvidenceSnapshot(),
    {
      environment: {
        ...answerAdmissionEnvironment,
        OPAS_DATABASE_DRIVER: "postgres",
      },
      createGenerationAdapter: () => ({
        ...generation,
        stream() {
          return (async function* () {
            throw failure;
          })();
        },
      }),
      getRepository: async () => repository,
    },
  );

  await assert.rejects(
    async () => {
      for await (const event of runtime.service.stream({
        question: "What did the retained source say?",
        workspaceId,
      })) {
        void event;
        // The fixture fails before an answer event is emitted.
      }
    },
    (error: unknown) => error === failure,
  );
  assert.equal(reservations.length, 1);
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0]?.status, "failed");
  assert.equal(
    reconciliations[0]?.chargedMicrodollars,
    reservations[0]?.reservedMicrodollars,
  );
  assert.equal(reconciliations[0]?.inputTokens, null);
  assert.equal(reconciliations[0]?.outputTokens, null);
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
        environment: {
          ...answerAdmissionEnvironment,
          OPAS_DATABASE_DRIVER: "postgres",
        },
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

test("contains a dual-provider outage while published lexical evidence stays available", async () => {
  const metadata = embeddingMetadata();
  const { repository } = repositoryFixture({ metadata });
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary: GenerationAdapter = {
    ...generationAdapter(),
    metadata: {
      model: "workers-primary-v1",
      provider: "cloudflare-workers-ai",
      retentionDisclosure: "Primary fixture requests are not retained.",
    },
    stream() {
      return (async function* () {
        primaryCalls += 1;
        throw new GenerationError(
          "provider-unavailable",
          "Primary provider unavailable",
        );
      })();
    },
  };
  const fallback: GenerationAdapter = {
    ...generationAdapter(),
    metadata: {
      model: "portable-fallback-v2",
      provider: "openai-compatible",
      retentionDisclosure: "Fallback fixture requests are not retained.",
    },
    stream() {
      return (async function* () {
        fallbackCalls += 1;
        throw new GenerationError(
          "provider-unavailable",
          "Fallback provider unavailable",
        );
      })();
    },
  };
  const runtime = await createConfiguredAnswerRuntime({
    environment: {
      ...answerAdmissionEnvironment,
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "400000",
      OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "600000",
      OPAS_ANSWER_LEASE_MILLISECONDS: "65000",
      OPAS_DATABASE_DRIVER: "postgres",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
      OPAS_GENERATION_FALLBACK_PROVIDER: "cloudflare-workers-ai",
    },
    createEmbeddingAdapter: async () =>
      embeddingAdapter(metadata, async () => ({
        metadata,
        vectors: [[1, 0, 0]],
      })),
    createGenerationAdapter: () =>
      createGenerationFallbackAdapter({ fallback, primary }),
    getRepository: async () => repository,
    workersAiBinding: { run: async () => ({}) } as never,
  });

  await assert.rejects(
    collect(runtime),
    (error) =>
      error instanceof GenerationError &&
      error.category === "provider-unavailable",
  );
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(await repository.listEvidenceChunks(workspaceId), [
    evidenceChunk(),
  ]);
});

test("final repository revalidation can only produce abstention, never a stale citation", async () => {
  const metadata = embeddingMetadata();
  let generationCalls = 0;
  const { repository, revalidationCalls } = repositoryFixture({
    metadata,
    revalidate: () => [],
  });
  const runtime = await createConfiguredAnswerRuntime({
    environment: {
      ...answerAdmissionEnvironment,
      OPAS_DATABASE_DRIVER: "d1",
    },
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
    environment: {
      ...answerAdmissionEnvironment,
      OPAS_DATABASE_DRIVER: "postgres",
    },
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

test("rejects malformed admission policy before bindings and provider or repository factories", async () => {
  let bindingCalls = 0;
  let generationCalls = 0;
  let repositoryCalls = 0;
  const privateValue = "private-admission-configuration";

  await assert.rejects(
    createConfiguredAnswerRuntime({
      environment: {
        ...answerAdmissionEnvironment,
        OPAS_ANSWER_MAXIMUM_CONCURRENCY: `4.0-${privateValue}`,
        OPAS_DATABASE_DRIVER: "d1",
      },
      createGenerationAdapter: () => {
        generationCalls += 1;
        return generationAdapter();
      },
      getRepository: async () => {
        repositoryCalls += 1;
        throw new Error("not reached");
      },
      getWorkersAiBinding: async () => {
        bindingCalls += 1;
        throw new Error("not reached");
      },
    }),
    (error) =>
      error instanceof Error &&
      error.message === "Answer inference is unavailable" &&
      !error.message.includes(privateValue),
  );

  assert.equal(bindingCalls, 0);
  assert.equal(generationCalls, 0);
  assert.equal(repositoryCalls, 0);
});

test("publishes the fixed CROFusion production sufficiency policy", () => {
  assert.deepEqual(answerEvidencePolicy, {
    minimumScore: 0.58,
    minimumScoreGapAcrossArticles: 0,
  });
  assert.ok(Object.isFrozen(answerEvidencePolicy));
  assert.deepEqual(answerEvidencePolicyCalibration, {
    fixtureId: "crofusion_answer_policy_v1",
    sourceContentHash:
      "dcc95593262ca7e1ef67686210e58be180e38d68d8b0ee6967f85f643c8d235b",
    provenance: "launch-partner-production",
    embeddingProvider: "cloudflare-workers-ai",
    embeddingModel: "@cf/baai/bge-base-en-v1.5",
    requiredAnswerCount: 20,
    unsupportedCount: 10,
    conflictingCount: 2,
    requiredAnswerScoreFloor: 0.5877803360052762,
    unsupportedScoreCeiling: 0.7538107319495362,
    minimumScoreGuard: 0.58,
    conflictingArticleGapCeiling: 0.00673885965448362,
    conflictingArticleGapGuard: 0,
    unsupportedResolution: "generation-abstention",
    conflictingResolution: "generation-abstention",
    designPartnerCalibration: "complete",
  });
  assert.ok(Object.isFrozen(answerEvidencePolicyCalibration));
});
