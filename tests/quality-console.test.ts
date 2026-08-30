// ABOUTME: Verifies active-scope quality review, evaluation comparison, safe CSV, and bounded runs.
// ABOUTME: Covers retained replay, exact summaries, production answer evaluation, and playground failures.
import assert from "node:assert/strict";
import test from "node:test";

import type { AnswerRuntime } from "@/answers/answer-runtime";
import type {
  EvaluationRun,
  EvidenceChunkRecord,
  SavedQuestionSet,
} from "@/db/repository";
import type { ConversationAnalyticsRecord } from "@/outcomes/records";
import type { ConversationAnalyticsStore } from "@/outcomes/store";
import type { EvidenceRetrievalResult } from "@/search/evidence";
import {
  compareQualityRuns,
  conversationLatencySummary,
  conversationOutcomeSummary,
  conversationQualityCsv,
  createQualityEvaluationResults,
  evaluateQualityReleaseGate,
  evaluationQualityCsv,
  parseQualityEvaluationResults,
  qualityConsoleRecordLimit,
  qualityCsvAttachmentHeaders,
  replayRetainedConversation,
  type QualityQuestionResult,
} from "@/quality/console";
import {
  loadQualityConsoleData,
  QualityConsoleError,
  runRetainedConversationReplay,
  runQualityPlayground,
  runSavedQuestionSet,
  type QualityRepository,
} from "@/quality/runtime";

const workspaceId = "workspace_demo";
const otherWorkspaceId = "workspace_other";
const recordedAt = new Date("2026-08-30T10:00:00.000Z");
const expiresAt = new Date("2026-09-29T10:00:00.000Z");
const sourceHash = "a".repeat(64);
const articleHash = "b".repeat(64);

function conversation(
  overrides: Partial<ConversationAnalyticsRecord> = {},
): ConversationAnalyticsRecord {
  return Object.freeze({
    bucketDay: "20260830",
    bucketSlot: 1,
    conversation: Object.freeze([
      Object.freeze({ content: "Earlier question", role: "user" as const }),
      Object.freeze({ content: "Earlier answer", role: "assistant" as const }),
      Object.freeze({ content: "=latest failed question", role: "user" as const }),
      Object.freeze({ content: "+retained answer", role: "assistant" as const }),
    ]),
    costMicrodollars: 42,
    durationMilliseconds: 320,
    expiresAt,
    firstTokenMilliseconds: 140,
    id: "123e4567-e89b-42d3-a456-426614174000",
    inputTokens: 20,
    model: "@unsafe-model",
    outcome: "low-rated",
    outputTokens: 10,
    provider: "=unsafe-provider",
    reason: "-unhelpful",
    retrievalTrace: Object.freeze([
      Object.freeze({
        articleContentHash: articleHash,
        articleId: "article_setup",
        canonicalUrl: "https://help.example.test/setup",
        contentHash: sourceHash,
        excerpt: "Use Workspace settings. [REDACTED]",
        headingPath: Object.freeze(["Workspace settings"]),
        indexGeneration: 4,
        mode: "lexical" as const,
        ordinal: 0,
        score: 0.92,
        sourceId: "chunk_setup",
        sourceLineRange: Object.freeze({ end: 2, start: 1 }),
        title: "Workspace setup",
      }),
    ]),
    startedAt: recordedAt,
    updatedAt: recordedAt,
    workspaceId,
    ...overrides,
  });
}

function result(
  overrides: Partial<QualityQuestionResult> = {},
): QualityQuestionResult {
  return Object.freeze({
    actualOutcome: "answer",
    answer: "Use Workspace settings.",
    citations: Object.freeze([
      Object.freeze({
        accepted: true,
        articleContentHash: articleHash,
        articleId: "article_setup",
        canonicalUrl: "https://help.example.test/setup",
        contentHash: sourceHash,
        id: "C1",
        provenanceValid: true,
        sourceId: "chunk_setup",
        title: "Workspace setup",
      }),
    ]),
    claims: Object.freeze([
      Object.freeze({
        citationCovered: true,
        citationId: "C1",
        markdown: "Use Workspace settings.",
        ordinal: 0,
        provenanceValid: true,
        sourceId: "chunk_setup",
      }),
    ]),
    classification: "answerable",
    costMicrodollars: 30,
    durationMilliseconds: 200,
    expectedOutcome: "answer",
    firstTokenMilliseconds: 125,
    generation: Object.freeze({
      model: "answer-v1",
      provider: "openai-compatible",
    }),
    id: "question_setup",
    inputTokens: 20,
    manualReview: null,
    outputTokens: 5,
    passed: true,
    provenanceValid: true,
    question: "How do I configure a workspace?",
    reason: null,
    sourceHit: true,
    totalTokens: 25,
    trace: Object.freeze([
      Object.freeze({
        articleContentHash: articleHash,
        articleId: "article_setup",
        canonicalUrl: "https://help.example.test/setup",
        contentHash: sourceHash,
        excerpt: "Use Workspace settings.",
        headingPath: Object.freeze(["Workspace settings"]),
        indexGeneration: 4,
        mode: "lexical" as const,
        ordinal: 0,
        score: 0.92,
        sourceId: "chunk_setup",
        sourceLineRange: Object.freeze({ end: 2, start: 1 }),
        title: "Workspace setup",
      }),
    ]),
    ...overrides,
  });
}

function evaluationRun(
  id: string,
  results: unknown,
  overrides: Partial<EvaluationRun> = {},
): EvaluationRun {
  return {
    completedAt: new Date(recordedAt.getTime() + 1_000),
    embeddingGenerationId: null,
    id,
    indexGeneration: 4,
    model: "answer-v1",
    provider: "openai-compatible",
    questionSetId: "question_set_one",
    results,
    retrievalMode: "production-answer-runtime",
    startedAt: recordedAt,
    status: "completed",
    workspaceId,
    ...overrides,
  };
}

function evidenceChunk(): EvidenceChunkRecord {
  return {
    articleContentHash: articleHash,
    articleId: "article_setup",
    canonicalUrl: "https://help.example.test/setup",
    contentHash: sourceHash,
    createdAt: recordedAt,
    embeddingInputHash: sourceHash,
    embeddingText: "Configure a workspace from Workspace settings.",
    evidenceText: "Configure a workspace from Workspace settings.",
    headingPath: ["Workspace settings"],
    id: "chunk_setup",
    indexGeneration: 4,
    markdown: "Configure a workspace from **Workspace settings**.",
    ordinal: 0,
    publicationState: "published",
    sourceLineRange: { end: 2, start: 1 },
    title: "Workspace setup",
    updatedAt: recordedAt,
    workspaceId,
  };
}

function questionSet(): SavedQuestionSet {
  return {
    createdAt: recordedAt,
    id: "question_set_one",
    name: "Release questions",
    questions: [
      {
        acceptedSourceIds: ["chunk_setup"],
        classification: "answerable",
        expectedOutcome: "answer",
        id: "question_setup",
        question: "How do I configure a workspace from Workspace settings?",
        sourceContentHashes: [sourceHash],
      },
    ],
    sourceContentHash: sourceHash,
    version: 1,
    workspaceId,
  };
}

function retrievedEvidence(): EvidenceRetrievalResult {
  return {
    articleContentHash: articleHash,
    articleId: "article_setup",
    canonicalUrl: "https://help.example.test/setup",
    chunkId: "chunk_setup",
    contentHash: sourceHash,
    evidenceText: "Configure a workspace from Workspace settings.",
    headingPath: ["Workspace settings"],
    indexGeneration: 4,
    markdown: "Configure a workspace from **Workspace settings**.",
    mode: "hybrid",
    ordinal: 0,
    score: 0.92,
    sourceId: "chunk_setup",
    sourceLineRange: { end: 2, start: 1 },
    title: "Workspace setup",
    workspaceId,
  };
}

function answerRuntime(
  options: Readonly<{
    abstain?: boolean;
    citationContentHash?: string;
    generation?: Readonly<{
      model: string;
      provider: "cloudflare-workers-ai" | "openai-compatible";
    }>;
    pause?: () => Promise<void>;
  }> = {},
): AnswerRuntime {
  return {
    metadata: {
      model: "answer-v1",
      provider: "openai-compatible",
      retentionDisclosure: "not retained",
    },
    service: {
      async *stream(request) {
        await options.pause?.();
        const evidence = retrievedEvidence();
        request.observeRetrieval?.([evidence]);
        if (options.abstain) {
          yield {
            message: "I could not find enough published information.",
            reason: "insufficient-evidence" as const,
            type: "abstention" as const,
          };
          return;
        }
        request.observeProvider?.(
          options.generation ?? {
            model: "answer-v1",
            provider: "openai-compatible",
          },
        );
        yield { markdown: "Use Workspace settings.", type: "content" as const };
        yield {
          citation: {
            articleContentHash: evidence.articleContentHash,
            articleId: evidence.articleId,
            canonicalUrl: evidence.canonicalUrl,
            contentHash: options.citationContentHash ?? evidence.contentHash,
            headingPath: evidence.headingPath,
            id: "C1",
            sourceId: evidence.sourceId,
            sourceLineRange: evidence.sourceLineRange,
            title: evidence.title,
          },
          type: "citation" as const,
        };
        yield {
          reason: "stop" as const,
          type: "finish" as const,
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        };
      },
    },
  };
}

function qualityRepository(overrides: Partial<QualityRepository> = {}): QualityRepository {
  return {
    async finishEvaluationRun() {},
    async getIndexingState(requestWorkspaceId) {
      return requestWorkspaceId === workspaceId
        ? {
            activeEmbeddingGenerationId: null,
            generation: 4,
            updatedAt: recordedAt,
            workspaceId,
          }
        : null;
    },
    async getQuestionSet(requestWorkspaceId, id) {
      return requestWorkspaceId === workspaceId && id === "question_set_one"
        ? questionSet()
        : null;
    },
    async listActiveChunkEmbeddings() {
      return [];
    },
    async listEvaluationRuns() {
      return [];
    },
    async listEvidenceChunks(requestWorkspaceId) {
      return requestWorkspaceId === workspaceId ? [evidenceChunk()] : [];
    },
    async listQuestionSets() {
      return [questionSet()];
    },
    async revalidateEvidenceCandidates(request) {
      return request.workspaceId === workspaceId && request.generation === 4
        ? request.candidates
        : [];
    },
    async startEvaluationRun() {},
    ...overrides,
  };
}

test("parses only exact recomputed evaluation summaries", () => {
  const valid = createQualityEvaluationResults([result()]);
  assert.deepEqual(parseQualityEvaluationResults(valid), valid);

  for (const inconsistent of [
    { ...valid, summary: { ...valid.summary, answered: 0, abstained: 1 } },
    { ...valid, summary: { ...valid.summary, passed: 0 } },
    { ...valid, summary: { ...valid.summary, total: 2 } },
  ]) {
    assert.equal(parseQualityEvaluationResults(inconsistent), null);
  }
  assert.equal(
    parseQualityEvaluationResults({
      ...valid,
      providerError: "secret upstream response",
    }),
    null,
  );
  assert.equal(
    parseQualityEvaluationResults({
      ...valid,
      questions: [
        {
          ...valid.questions[0]!,
          citations: [
            {
              ...valid.questions[0]!.citations[0],
              contentHash: "c".repeat(64),
            },
          ],
        },
      ],
    }),
    null,
  );
});

test("recomputes strict manual score denominators for every question class", () => {
  const reviewedAt = "2026-08-30T11:00:00.000Z";
  const reviewed = result({
    manualReview: Object.freeze({
      claims: Object.freeze([
        Object.freeze({ citationCovered: true, entailed: false, ordinal: 0 }),
      ]),
      grounded: true,
      materiallyCorrect: true,
      reviewedAt,
    }),
  });
  const results = createQualityEvaluationResults([reviewed]);
  assert.equal(results.schema, "opas.quality-evaluation.v3");
  assert.deepEqual(results.summary.manualAnswerScore, {
    denominator: 1,
    numerator: 1,
  });
  assert.deepEqual(results.summary.manualClaimScore, {
    denominator: 1,
    numerator: 0,
  });
  assert.equal(results.summary.perClassification.length, 5);
  assert.deepEqual(results.summary.perClassification[0], {
    automaticPass: { denominator: 1, numerator: 1 },
    classification: "answerable",
    manualAnswerScore: { denominator: 1, numerator: 1 },
    manualClaimScore: { denominator: 1, numerator: 0 },
  });
  assert.deepEqual(results.summary.perClassification[4], {
    automaticPass: { denominator: 0, numerator: 0 },
    classification: "adversarial",
    manualAnswerScore: { denominator: 0, numerator: 0 },
    manualClaimScore: { denominator: 0, numerator: 0 },
  });
  assert.equal(
    parseQualityEvaluationResults({
      ...results,
      schema: "opas.quality-evaluation.v2",
    }),
    null,
  );
  assert.equal(
    parseQualityEvaluationResults({
      ...results,
      questions: [
        {
          ...reviewed,
          manualReview: {
            ...reviewed.manualReview,
            claims: [{ citationCovered: true, entailed: true, ordinal: 1 }],
          },
        },
      ],
    }),
    null,
  );
});

test("compares only completed runs from the same workspace", () => {
  const baseline = evaluationRun(
    "run_baseline",
    createQualityEvaluationResults([
      result({
        citations: Object.freeze([
          Object.freeze({ ...result().citations[0]!, accepted: false }),
        ]),
        passed: false,
        sourceHit: false,
      }),
    ]),
  );
  const candidate = evaluationRun(
    "run_candidate",
    createQualityEvaluationResults([result()]),
  );
  assert.deepEqual(compareQualityRuns(baseline, candidate), {
    baselineId: "run_baseline",
    candidateId: "run_candidate",
    passedDelta: 1,
    rows: [
      {
        baselinePassed: false,
        candidatePassed: true,
        id: "question_setup",
        question: "How do I configure a workspace?",
        status: "improved",
      },
    ],
  });
  assert.equal(
    compareQualityRuns(
      baseline,
      evaluationRun("run_cross", candidate.results, {
        workspaceId: otherWorkspaceId,
      }),
    ),
    null,
  );
});

test("replays only retained redacted messages and source trace", () => {
  const replay = replayRetainedConversation(conversation());
  assert.equal(replay.question, "=latest failed question");
  assert.equal(replay.answer, "+retained answer");
  assert.equal(replay.trace[0]?.sourceId, "chunk_setup");
  assert.equal(replay.trace[0]?.contentHash, sourceHash);
  assert.equal(replay.trace[0]?.articleContentHash, articleHash);
  assert.deepEqual(replay.trace[0]?.headingPath, ["Workspace settings"]);
  assert.deepEqual(replay.trace[0]?.sourceLineRange, { end: 2, start: 1 });
  assert.equal(replay.trace[0]?.excerpt, "Use Workspace settings. [REDACTED]");
  assert.equal("providerError" in replay, false);
});

test("reproduces a retained failure using only its redacted evidence snapshot", async () => {
  const scope = Object.freeze({
    readAt: new Date("2026-08-30T12:00:00.000Z"),
    retentionStartedAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  const reads: unknown[][] = [];
  let retainedEvidence: readonly EvidenceRetrievalResult[] = [];
  const replay = await runRetainedConversationReplay(
    workspaceId,
    conversation().id,
    {
      scope,
      status: "enabled",
      store: {
        async get(...parameters: Parameters<ConversationAnalyticsStore["get"]>) {
          reads.push(parameters);
          return conversation();
        },
      } as ConversationAnalyticsStore,
    },
    {
      async createAnswerRuntime(evidence) {
        retainedEvidence = evidence;
        return {
          metadata: {
            model: "configured-primary",
            provider: "cloudflare-workers-ai",
            retentionDisclosure: "not retained",
          },
          service: {
            async *stream(request) {
              assert.equal(request.workspaceId, workspaceId);
              assert.equal(request.question, "=latest failed question");
              assert.deepEqual(request.history, [
                { content: "Earlier question", role: "user" },
                { content: "Earlier answer", role: "assistant" },
              ]);
              request.observeProvider?.({
                model: "configured-fallback",
                provider: "openai-compatible",
              });
              request.observeRetrieval?.(evidence);
              yield {
                markdown: "Use the retained Workspace settings excerpt.",
                type: "content" as const,
              };
              yield {
                citation: {
                  articleContentHash: evidence[0]!.articleContentHash,
                  articleId: evidence[0]!.articleId,
                  canonicalUrl: evidence[0]!.canonicalUrl,
                  contentHash: evidence[0]!.contentHash,
                  headingPath: evidence[0]!.headingPath,
                  id: "C1",
                  sourceId: evidence[0]!.sourceId,
                  sourceLineRange: evidence[0]!.sourceLineRange,
                  title: evidence[0]!.title,
                },
                type: "citation" as const,
              };
              yield {
                reason: "stop" as const,
                type: "finish" as const,
                usage: { inputTokens: 18, outputTokens: 7, totalTokens: 25 },
              };
            },
          },
        };
      },
    },
  );

  assert.deepEqual(reads, [[workspaceId, conversation().id, scope]]);
  assert.deepEqual(retainedEvidence, [
    {
      articleContentHash: articleHash,
      articleId: "article_setup",
      canonicalUrl: "https://help.example.test/setup",
      chunkId: "chunk_setup",
      contentHash: sourceHash,
      evidenceText: "Use Workspace settings. [REDACTED]",
      headingPath: ["Workspace settings"],
      indexGeneration: 4,
      markdown: "Use Workspace settings. [REDACTED]",
      mode: "lexical",
      ordinal: 0,
      score: 0.92,
      sourceId: "chunk_setup",
      sourceLineRange: { end: 2, start: 1 },
      title: "Workspace setup",
      workspaceId,
    },
  ]);
  assert.deepEqual(replay, {
    answer: "Use the retained Workspace settings excerpt.",
    citations: [{ id: "C1", sourceId: "chunk_setup" }],
    generation: {
      model: "configured-fallback",
      provider: "openai-compatible",
    },
    outcome: "answer",
    question: "=latest failed question",
    reason: null,
  });
});

test("fails retained reproduction closed across scope, expiry, and evidence boundaries", async (context) => {
  const scope = Object.freeze({
    readAt: new Date("2026-08-30T12:00:00.000Z"),
    retentionStartedAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  let runtimeCalls = 0;
  const dependencies = {
    async createAnswerRuntime() {
      runtimeCalls += 1;
      return answerRuntime();
    },
  };

  await context.test("disabled retention", async () => {
    await assert.rejects(
      runRetainedConversationReplay(
        workspaceId,
        conversation().id,
        { status: "disabled" },
        dependencies,
      ),
      (error: unknown) =>
        error instanceof QualityConsoleError && error.code === "not-ready",
    );
  });

  for (const [name, record, code] of [
    ["expired or absent", null, "not-found"],
    [
      "cross-workspace record",
      conversation({ workspaceId: otherWorkspaceId }),
      "unavailable",
    ],
    [
      "expired record returned by a faulty store",
      conversation({ expiresAt: scope.readAt }),
      "unavailable",
    ],
    [
      "record before retention scope returned by a faulty store",
      conversation({
        startedAt: new Date(scope.retentionStartedAt.getTime() - 1),
      }),
      "unavailable",
    ],
    ["missing retained evidence", conversation({ retrievalTrace: [] }), "not-ready"],
    [
      "fully redacted retained evidence",
      conversation({
        retrievalTrace: [
          { ...conversation().retrievalTrace[0]!, excerpt: "[REDACTED]" },
        ],
      }),
      "not-ready",
    ],
  ] as const) {
    await context.test(name, async () => {
      await assert.rejects(
        runRetainedConversationReplay(
          workspaceId,
          conversation().id,
          {
            scope,
            status: "enabled",
            store: {
              async get() {
                return record;
              },
            } as unknown as ConversationAnalyticsStore,
          },
          dependencies,
        ),
        (error: unknown) =>
          error instanceof QualityConsoleError && error.code === code,
      );
    });
  }
  assert.equal(runtimeCalls, 0);
});

test("rejects retained generation citations that do not exactly map to the snapshot", async () => {
  const scope = Object.freeze({
    readAt: new Date("2026-08-30T12:00:00.000Z"),
    retentionStartedAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  await assert.rejects(
    runRetainedConversationReplay(
      workspaceId,
      conversation().id,
      {
        scope,
        status: "enabled",
        store: {
          async get() {
            return conversation();
          },
        } as unknown as ConversationAnalyticsStore,
      },
      {
        async createAnswerRuntime(evidence) {
          return {
            metadata: {
              model: "answer-v1",
              provider: "openai-compatible",
              retentionDisclosure: "not retained",
            },
            service: {
              async *stream() {
                yield { markdown: "Unsupported mapping.", type: "content" as const };
                yield {
                  citation: {
                    articleContentHash: evidence[0]!.articleContentHash,
                    articleId: evidence[0]!.articleId,
                    canonicalUrl: evidence[0]!.canonicalUrl,
                    contentHash: evidence[0]!.contentHash,
                    headingPath: evidence[0]!.headingPath,
                    id: "C2",
                    sourceId: evidence[0]!.sourceId,
                    sourceLineRange: evidence[0]!.sourceLineRange,
                    title: evidence[0]!.title,
                  },
                  type: "citation" as const,
                };
              },
            },
          };
        },
      },
    ),
    (error: unknown) =>
      error instanceof QualityConsoleError && error.code === "unavailable",
  );
});

test("summarizes retained production first-content-token and total latency independently", () => {
  assert.deepEqual(
    conversationLatencySummary([
      conversation({ durationMilliseconds: 500, firstTokenMilliseconds: 100 }),
      conversation({
        durationMilliseconds: 700,
        firstTokenMilliseconds: 50,
        outcome: "abstained",
      }),
      conversation({ durationMilliseconds: 600, firstTokenMilliseconds: 200 }),
    ]),
    {
      firstTokenSamples: 2,
      firstTokenP95Milliseconds: 200,
      totalLatencyP95Milliseconds: 700,
      totalSamples: 3,
    },
  );
});

test("reconciles every retained outcome into one explicit aggregate", () => {
  const records = [
    conversation({ id: "123e4567-e89b-42d3-a456-426614174001", outcome: "answered" }),
    conversation({ id: "123e4567-e89b-42d3-a456-426614174002", outcome: "abstained" }),
    conversation({ id: "123e4567-e89b-42d3-a456-426614174003", outcome: "low-rated" }),
    conversation({ id: "123e4567-e89b-42d3-a456-426614174004", outcome: "escalated" }),
    conversation({ id: "123e4567-e89b-42d3-a456-426614174005", outcome: "abandoned" }),
  ];
  assert.deepEqual(conversationOutcomeSummary(records), {
    counts: {
      abandoned: 1,
      abstained: 1,
      answered: 1,
      escalated: 1,
      "low-rated": 1,
    },
    reconciled: true,
    reconciledTotal: 5,
    total: 5,
  });
});

test("release gate evaluates five ratios and production TTFT without treating absent evidence as passing", () => {
  const reviewedAnswer = result({
    manualReview: {
      claims: [{ citationCovered: true, entailed: true, ordinal: 0 }],
      grounded: true,
      materiallyCorrect: true,
      reviewedAt: "2026-08-30T11:00:00.000Z",
    },
  });
  const abstention = (
    classification: "adversarial" | "unsupported",
    id: string,
  ): QualityQuestionResult =>
    result({
      actualOutcome: "abstain",
      answer: null,
      citations: [],
      claims: [],
      classification,
      costMicrodollars: 0,
      expectedOutcome: "abstain",
      firstTokenMilliseconds: null,
      generation: null,
      id,
      inputTokens: 0,
      manualReview: null,
      outputTokens: 0,
      passed: true,
      provenanceValid: true,
      reason: "insufficient-evidence",
      sourceHit: false,
      totalTokens: 0,
      trace: [],
    });
  const complete = createQualityEvaluationResults([
    reviewedAnswer,
    abstention("unsupported", "question_unsupported"),
    abstention("adversarial", "question_adversarial"),
  ]);
  const ready = evaluateQualityReleaseGate(
    complete,
    conversationLatencySummary([
      conversation({
        durationMilliseconds: 3_500,
        firstTokenMilliseconds: 2_999,
        outcome: "answered",
      }),
      conversation({
        durationMilliseconds: 20,
        firstTokenMilliseconds: null,
        outcome: "abstained",
      }),
    ]),
  );
  assert.equal(ready.status, "ready");
  assert.equal(ready.ratios.length, 5);
  assert.ok(ready.ratios.every(({ status }) => status === "pass"));
  assert.deepEqual(ready.productionFirstToken, {
    maximumP95Milliseconds: 3_000,
    p95Milliseconds: 2_999,
    sampleCount: 1,
    status: "pass",
  });

  const incomplete = evaluateQualityReleaseGate(
    createQualityEvaluationResults([result()]),
    conversationLatencySummary([
      conversation({ firstTokenMilliseconds: null, outcome: "abstained" }),
    ]),
  );
  assert.equal(incomplete.status, "missing-evidence");
  assert.deepEqual(
    Object.fromEntries(
      incomplete.ratios.map(({ id, status }) => [id, status]),
    ),
    {
      "answerable-responses": "pass",
      "citation-provenance": "pass",
      "manual-answers": "missing-evidence",
      "manual-claims": "missing-evidence",
      "unsupported-adversarial-abstentions": "missing-evidence",
    },
  );
  assert.equal(incomplete.productionFirstToken.status, "missing-evidence");

  const blocked = evaluateQualityReleaseGate(
    createQualityEvaluationResults([
      {
        ...reviewedAnswer,
        manualReview: {
          ...reviewedAnswer.manualReview!,
          grounded: false,
        },
      },
      abstention("unsupported", "question_unsupported"),
      abstention("adversarial", "question_adversarial"),
    ]),
    conversationLatencySummary([
      conversation({
        durationMilliseconds: 3_100,
        firstTokenMilliseconds: 3_001,
        outcome: "answered",
      }),
    ]),
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(
    blocked.ratios.find(({ id }) => id === "manual-answers")?.status,
    "fail",
  );
  assert.equal(blocked.productionFirstToken.status, "fail");
});

test("exports formula-safe CSV with fixed attachment headers", () => {
  const conversations = conversationQualityCsv([conversation()]);
  assert.match(conversations, /"'=unsafe-provider"/u);
  assert.match(conversations, /"'@unsafe-model"/u);
  assert.match(conversations, /"'=latest failed question"/u);
  assert.match(conversations, /"'\+retained answer"/u);
  assert.match(conversations, /"'-unhelpful"/u);
  assert.match(conversations, /Use Workspace settings\. \[REDACTED\]/u);
  assert.match(conversations, /"total_latency_ms","first_content_token_ms"/u);
  assert.match(conversations, new RegExp(sourceHash, "u"));
  assert.match(conversations, new RegExp(articleHash, "u"));
  assert.match(conversations, /Workspace settings/u);
  assert.match(conversations, /1-2/u);

  const evaluations = evaluationQualityCsv([
    evaluationRun(
      "=run",
      createQualityEvaluationResults([result({ question: "@question" })]),
    ),
    evaluationRun("failed_run", null, { status: "failed" }),
  ]);
  assert.match(evaluations, /"duration_ms","first_content_token_ms"/u);
  assert.match(evaluations, /"'=run"/u);
  assert.match(evaluations, /"'@question"/u);
  assert.match(
    evaluations,
    /"class_manual_answer_numerator","class_manual_answer_denominator"/u,
  );
  for (const classification of [
    "answerable",
    "ambiguous",
    "unsupported",
    "stale-conflicting",
    "adversarial",
  ]) {
    assert.match(evaluations, new RegExp(`"${classification}"`, "u"));
  }
  const evaluationRows = evaluations.trimEnd().split("\r\n");
  const evaluationColumnCount = evaluationRows[0]!.split('\",\"').length;
  assert.ok(
    evaluationRows.every(
      (row) => row.split('\",\"').length === evaluationColumnCount,
    ),
  );

  assert.deepEqual(qualityCsvAttachmentHeaders("bad\r\nname.csv"), {
    "Cache-Control": "private, no-store",
    "Content-Disposition": 'attachment; filename="opas-quality.csv"',
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "text/csv; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
});

test("loads active workspace records through the exact unexpired scope", async () => {
  const scope = {
    readAt: new Date("2026-08-30T12:00:00.000Z"),
    retentionStartedAt: new Date("2026-07-31T12:00:00.000Z"),
  };
  const reads: unknown[][] = [];
  const store = {
    async list(...parameters: unknown[]) {
      reads.push(parameters);
      return [conversation()];
    },
  } as unknown as ConversationAnalyticsStore;
  const loaded = await loadQualityConsoleData(
    workspaceId,
    qualityRepository({
      async listEvaluationRuns(requestWorkspaceId, limit) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(limit, qualityConsoleRecordLimit);
        return [];
      },
      async listQuestionSets(requestWorkspaceId, limit) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(limit, qualityConsoleRecordLimit);
        return [questionSet()];
      },
    }),
    { scope, status: "enabled", store },
  );
  assert.deepEqual(reads, [[workspaceId, scope, qualityConsoleRecordLimit]]);
  assert.equal(loaded.conversations.length, 1);
  assert.equal(loaded.questionSets.length, 1);
});

test("runs saved sets through production answer generation with current provenance", async () => {
  const started: unknown[] = [];
  const finished: unknown[] = [];
  let answerRuntimeCalls = 0;
  const ticks = [0, 125, 200];
  const response = await runSavedQuestionSet(workspaceId, "question_set_one", {
    costRates: [
      {
        inputMicrodollarsPerMillionTokens: "1000000",
        model: "answer-v1",
        outputMicrodollarsPerMillionTokens: "2000000",
        provider: "openai-compatible",
      },
    ],
    createAnswerRuntime: async () => {
      answerRuntimeCalls += 1;
      return answerRuntime();
    },
    monotonicNow: () => ticks.shift() ?? 200,
    now: () => recordedAt,
    randomId: () => "run_release_one",
    repository: qualityRepository({
      async finishEvaluationRun(completion) {
        finished.push(completion);
      },
      async startEvaluationRun(run) {
        started.push(run);
      },
    }),
  });

  assert.equal(answerRuntimeCalls, 1);
  assert.equal(started.length, 1);
  assert.deepEqual(
    {
      model: (started[0] as { model: string }).model,
      provider: (started[0] as { provider: string }).provider,
      retrievalMode: (started[0] as { retrievalMode: string }).retrievalMode,
    },
    {
      model: "answer-v1",
      provider: "openai-compatible",
      retrievalMode: "production-answer-runtime",
    },
  );
  assert.equal(finished.length, 1);
  assert.equal(response.results.questions[0]?.trace[0]?.sourceId, "chunk_setup");
  assert.equal(response.results.questions[0]?.trace[0]?.contentHash, sourceHash);
  assert.equal(response.results.questions[0]?.citations[0]?.accepted, true);
  assert.equal(response.results.questions[0]?.claims[0]?.citationCovered, true);
  assert.equal(response.results.questions[0]?.answer, "Use Workspace settings.");
  assert.equal(response.results.questions[0]?.firstTokenMilliseconds, 125);
  assert.equal(response.results.questions[0]?.durationMilliseconds, 200);
  assert.equal(response.results.questions[0]?.costMicrodollars, 30);
  assert.equal(response.results.summary.firstTokenP95Milliseconds, 125);
  assert.equal(response.results.questions[0]?.passed, true);

  await assert.rejects(
    runSavedQuestionSet(otherWorkspaceId, "question_set_one", {
      createAnswerRuntime: async () => {
        return answerRuntime();
      },
      repository: qualityRepository(),
    }),
    (error: unknown) =>
      error instanceof QualityConsoleError && error.code === "not-found",
  );
});

test("attributes saved answers and cost to the provider that actually completed", async () => {
  const response = await runSavedQuestionSet(workspaceId, "question_set_one", {
    costRates: [
      {
        inputMicrodollarsPerMillionTokens: "1000000",
        model: "answer-v1",
        outputMicrodollarsPerMillionTokens: "2000000",
        provider: "openai-compatible",
      },
      {
        inputMicrodollarsPerMillionTokens: "3000000",
        model: "fallback-v2",
        outputMicrodollarsPerMillionTokens: "4000000",
        provider: "cloudflare-workers-ai",
      },
    ],
    createAnswerRuntime: async () =>
      answerRuntime({
        generation: {
          model: "fallback-v2",
          provider: "cloudflare-workers-ai",
        },
      }),
    repository: qualityRepository(),
  });
  assert.deepEqual(response.results.questions[0]?.generation, {
    model: "fallback-v2",
    provider: "cloudflare-workers-ai",
  });
  assert.equal(response.results.questions[0]?.costMicrodollars, 80);
  assert.deepEqual(response.results.summary.generations, [
    {
      costMicrodollars: 80,
      model: "fallback-v2",
      provider: "cloudflare-workers-ai",
      questions: 1,
    },
  ]);
});

test("scores the runtime abstention rather than the retrieved source IDs", async () => {
  const response = await runSavedQuestionSet(workspaceId, "question_set_one", {
    createAnswerRuntime: async () => answerRuntime({ abstain: true }),
    repository: qualityRepository({
      async getQuestionSet() {
        return {
          ...questionSet(),
          questions: [
            {
              ...questionSet().questions[0]!,
              acceptedSourceIds: [],
              expectedOutcome: "abstain",
              sourceContentHashes: [],
            },
          ],
        };
      },
    }),
  });
  assert.equal(response.results.questions[0]?.actualOutcome, "abstain");
  assert.equal(response.results.questions[0]?.reason, "insufficient-evidence");
  assert.equal(response.results.questions[0]?.answer, null);
  assert.equal(response.results.questions[0]?.inputTokens, 0);
  assert.equal(response.results.questions[0]?.costMicrodollars, 0);
  assert.equal(response.results.questions[0]?.passed, true);
});

test("bounds saved-set generation concurrency and fails before the route deadline", async () => {
  const manyQuestions = Array.from({ length: 12 }, (_, index) => ({
    ...questionSet().questions[0]!,
    id: `question_${index}`,
    question: `How do I configure workspace setting ${index}?`,
  }));
  let activeGenerations = 0;
  let maximumActiveGenerations = 0;
  await runSavedQuestionSet(workspaceId, "question_set_one", {
    createAnswerRuntime: async () =>
      answerRuntime({
        async pause() {
          activeGenerations += 1;
          maximumActiveGenerations = Math.max(
            maximumActiveGenerations,
            activeGenerations,
          );
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
          activeGenerations -= 1;
        },
      }),
    repository: qualityRepository({
      async getQuestionSet() {
        return { ...questionSet(), questions: manyQuestions };
      },
    }),
  });
  assert.ok(maximumActiveGenerations > 1);
  assert.ok(maximumActiveGenerations <= 4);

  const finished: Array<{ status: string }> = [];
  const startedAt = performance.now();
  await assert.rejects(
    runSavedQuestionSet(workspaceId, "question_set_one", {
      createAnswerRuntime: async () =>
        answerRuntime({ pause: async () => new Promise<void>(() => {}) }),
      evaluationTimeoutMilliseconds: 5,
      repository: qualityRepository({
        async finishEvaluationRun(completion) {
          finished.push(completion);
        },
      }),
    }),
    (error: unknown) =>
      error instanceof QualityConsoleError && error.code === "unavailable",
  );
  assert.ok(performance.now() - startedAt < 500);
  assert.deepEqual(finished.map(({ status }) => status), ["failed"]);
});

test("rejects generated citations whose content provenance differs from retrieval", async () => {
  const finished: Array<{ status: string }> = [];
  await assert.rejects(
    runSavedQuestionSet(workspaceId, "question_set_one", {
      createAnswerRuntime: async () =>
        answerRuntime({ citationContentHash: "c".repeat(64) }),
      repository: qualityRepository({
        async finishEvaluationRun(completion) {
          finished.push(completion);
        },
      }),
    }),
    (error: unknown) =>
      error instanceof QualityConsoleError && error.code === "unavailable",
  );
  assert.deepEqual(finished.map(({ status }) => status), ["failed"]);
});

test("fails an answer when its current citation no longer matches the saved source hash", async () => {
  const response = await runSavedQuestionSet(workspaceId, "question_set_one", {
    createAnswerRuntime: async () => answerRuntime(),
    repository: qualityRepository({
      async getQuestionSet() {
        return {
          ...questionSet(),
          questions: [
            {
              ...questionSet().questions[0]!,
              sourceContentHashes: ["d".repeat(64)],
            },
          ],
        };
      },
    }),
  });
  assert.equal(response.results.questions[0]?.provenanceValid, true);
  assert.equal(response.results.questions[0]?.sourceHit, false);
  assert.equal(response.results.questions[0]?.citations[0]?.accepted, false);
  assert.equal(response.results.questions[0]?.passed, false);
});

test("keeps playground lexical preflight distinct from generated citations", async () => {
  const runtime = {
    metadata: {
      model: "answer-v1",
      provider: "openai-compatible",
      retentionDisclosure: "not retained",
    },
    service: {
      async *stream() {
        yield { markdown: "Use workspace settings.", type: "content" as const };
        yield {
          citation: {
            articleContentHash: articleHash,
            articleId: "article_setup",
            canonicalUrl: "https://help.example.test/setup",
            contentHash: sourceHash,
            headingPath: ["Workspace settings"],
            id: "C1",
            sourceId: "chunk_generation_choice",
            sourceLineRange: { end: 2, start: 1 },
            title: "Workspace setup",
          },
          type: "citation" as const,
        };
        yield {
          reason: "stop" as const,
          type: "finish" as const,
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        };
      },
    },
  } as AnswerRuntime;
  const playground = await runQualityPlayground(
    workspaceId,
    "How do I configure a workspace?",
    {
      createAnswerRuntime: async () => runtime,
      repository: qualityRepository(),
    },
  );
  assert.equal(playground.preflightTrace[0]?.sourceId, "chunk_setup");
  assert.deepEqual(playground.citations, ["chunk_generation_choice"]);
  assert.equal("trace" in playground, false);

  const unavailable = await runQualityPlayground(workspaceId, "How do I configure it?", {
    createAnswerRuntime: async () => {
      throw new Error("secret provider failure with token sk-not-for-ui");
    },
    repository: qualityRepository(),
  });
  assert.equal(unavailable.outcome, "unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable), /secret|sk-not-for-ui/u);
  assert.equal(unavailable.preflightTrace.length, 1);

  const startedAt = performance.now();
  const timedOut = await runQualityPlayground(workspaceId, "Does this finish?", {
    createAnswerRuntime: async () => new Promise<AnswerRuntime>(() => {}),
    repository: qualityRepository(),
    timeoutMilliseconds: 5,
  });
  assert.equal(timedOut.outcome, "unavailable");
  assert.ok(performance.now() - startedAt < 500);
});
