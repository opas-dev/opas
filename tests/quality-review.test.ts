// ABOUTME: Verifies strict authenticated human scoring for saved evaluation answers and claims.
// ABOUTME: Covers atomic persistence, recomputed class ratios, bounded imports, and safe failures.
import assert from "node:assert/strict";
import test from "node:test";

import type { EvaluationRun } from "@/db/repository";
import {
  createQualityEvaluationResults,
  parseQualityEvaluationResults,
} from "@/quality/console";
import { handleQualityReviewRequest } from "@/quality/http";
import {
  importQualityReview,
  QualityReviewImportError,
} from "@/quality/review-import";

const workspaceId = "workspace_demo";
const sourceHash = "a".repeat(64);
const articleHash = "b".repeat(64);
const completedAt = new Date("2026-08-30T10:00:00.000Z");
const qualityActor = Object.freeze({
  memberId: "member_quality_reviewer",
  sessionId: "session_quality_reviewer",
  workspaceId,
});

function results() {
  return createQualityEvaluationResults([
    {
      actualOutcome: "answer",
      answer: "Use Workspace settings.",
      citations: [
        {
          accepted: true,
          articleContentHash: articleHash,
          articleId: "article_setup",
          canonicalUrl: "https://help.example.test/setup",
          contentHash: sourceHash,
          id: "C1",
          provenanceValid: true,
          sourceId: "chunk_setup",
          title: "Workspace setup",
        },
      ],
      claims: [
        {
          citationCovered: true,
          citationId: "C1",
          markdown: "Use Workspace settings.",
          ordinal: 0,
          provenanceValid: true,
          sourceId: "chunk_setup",
        },
      ],
      classification: "answerable",
      costMicrodollars: 30,
      durationMilliseconds: 200,
      expectedOutcome: "answer",
      firstTokenMilliseconds: 125,
      generation: {
        model: "answer-v1",
        provider: "openai-compatible",
      },
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
      trace: [
        {
          articleContentHash: articleHash,
          articleId: "article_setup",
          canonicalUrl: "https://help.example.test/setup",
          contentHash: sourceHash,
          excerpt: "Use Workspace settings.",
          headingPath: ["Workspace settings"],
          indexGeneration: 4,
          mode: "lexical",
          ordinal: 0,
          score: 0.92,
          sourceId: "chunk_setup",
          sourceLineRange: { end: 2, start: 1 },
          title: "Workspace setup",
        },
      ],
    },
  ]);
}

function run(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    completedAt,
    embeddingGenerationId: null,
    id: "run_release_one",
    indexGeneration: 4,
    model: "answer-v1",
    provider: "openai-compatible",
    questionSetId: "question_set_one",
    results: results(),
    retrievalMode: "production-answer-runtime",
    startedAt: new Date(completedAt.getTime() - 1_000),
    status: "completed",
    workspaceId,
    ...overrides,
  };
}

function reviewPayload() {
  return {
    questions: [
      {
        claims: [{ citationCovered: true, entailed: false, ordinal: 0 }],
        grounded: true,
        id: "question_setup",
        materiallyCorrect: true,
      },
    ],
    runId: "run_release_one",
    schema: "opas.quality-review.v1",
  };
}

test("imports manual answer and claim judgments with recomputed class scores", async () => {
  const updates: unknown[] = [];
  const imported = await importQualityReview(
    workspaceId,
    reviewPayload(),
    {
      async getEvaluationRun(requestWorkspaceId, id) {
        assert.equal(requestWorkspaceId, workspaceId);
        assert.equal(id, "run_release_one");
        return run();
      },
      async updateAuthorizedEvaluationRunResults(request, update) {
        assert.equal(request.memberId, qualityActor.memberId);
        assert.equal(request.sessionId, qualityActor.sessionId);
        assert.equal(request.workspaceId, qualityActor.workspaceId);
        assert.equal(request.checkedAt.toISOString(), "2026-08-30T11:00:00.000Z");
        updates.push(update);
      },
    },
    qualityActor,
    () => new Date("2026-08-30T11:00:00.000Z"),
  );

  assert.equal(imported.questionCount, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(imported.results.questions[0]?.manualReview, {
    claims: [{ citationCovered: true, entailed: false, ordinal: 0 }],
    grounded: true,
    materiallyCorrect: true,
    reviewedAt: "2026-08-30T11:00:00.000Z",
  });
  assert.deepEqual(imported.results.summary.manualAnswerScore, {
    denominator: 1,
    numerator: 1,
  });
  assert.deepEqual(imported.results.summary.manualClaimScore, {
    denominator: 1,
    numerator: 0,
  });
  assert.deepEqual(imported.results.summary.perClassification[0], {
    automaticPass: { denominator: 1, numerator: 1 },
    classification: "answerable",
    manualAnswerScore: { denominator: 1, numerator: 1 },
    manualClaimScore: { denominator: 1, numerator: 0 },
  });
  assert.ok(parseQualityEvaluationResults(imported.results));
});

test("rejects incomplete, mismatched, stale-schema, and non-completed reviews", async () => {
  let updateCalls = 0;
  let currentRun = run();
  const repository = {
    async getEvaluationRun() {
      return currentRun;
    },
    async updateAuthorizedEvaluationRunResults() {
      updateCalls += 1;
    },
  };
  const invalid = [
    { ...reviewPayload(), schema: "opas.quality-review.v0" },
    { ...reviewPayload(), workspaceId: "workspace_other" },
    {
      ...reviewPayload(),
      questions: [
        {
          ...reviewPayload().questions[0],
          claims: [],
        },
      ],
    },
    {
      ...reviewPayload(),
      questions: [
        {
          ...reviewPayload().questions[0],
          claims: [{ citationCovered: true, entailed: true, ordinal: 1 }],
        },
      ],
    },
    {
      ...reviewPayload(),
      questions: [{ ...reviewPayload().questions[0], id: "question_missing" }],
    },
  ];
  for (const payload of invalid) {
    await assert.rejects(
      importQualityReview(workspaceId, payload, repository, qualityActor),
      (error: unknown) =>
        error instanceof QualityReviewImportError &&
        error.code === "invalid-request",
    );
  }
  currentRun = run({ status: "running" });
  await assert.rejects(
    importQualityReview(workspaceId, reviewPayload(), repository, qualityActor),
    (error: unknown) =>
      error instanceof QualityReviewImportError && error.code === "not-ready",
  );
  assert.equal(updateCalls, 0);
});

test("review HTTP authorizes first and accepts only same-origin bounded JSON", async () => {
  const origin = "https://quality.example.test";
  let imports = 0;
  const dependencies = {
    authorize: async () => qualityActor,
    async importReview(value: unknown, actor: typeof qualityActor) {
      imports += 1;
      assert.deepEqual(value, reviewPayload());
      assert.deepEqual(actor, qualityActor);
      return { questionCount: 1, runId: "run_release_one" };
    },
  };
  const response = await handleQualityReviewRequest(
    new Request(`${origin}/admin/quality/review`, {
      body: JSON.stringify(reviewPayload()),
      headers: {
        "content-type": "application/json; charset=utf-8",
        host: new URL(origin).host,
        origin,
      },
      method: "POST",
    }),
    dependencies,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    review: { questionCount: 1, runId: "run_release_one" },
  });

  const crossOrigin = await handleQualityReviewRequest(
    new Request(`${origin}/admin/quality/review`, {
      body: JSON.stringify(reviewPayload()),
      headers: {
        "content-type": "application/json",
        host: new URL(origin).host,
        origin: "https://attacker.example.test",
      },
      method: "POST",
    }),
    dependencies,
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(imports, 1);
});
