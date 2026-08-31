// ABOUTME: Recomputes answer evidence boundaries from production and synthetic retrieval fixtures.
// ABOUTME: Keeps score and conflict thresholds tied to explicit hash-bound measurements.
import assert from "node:assert/strict";
import test from "node:test";

import {
  answerEvidencePolicy,
  answerEvidencePolicyCalibration,
} from "@/answers/answer-runtime";
import type {
  ActiveChunkEmbedding,
  EvidenceCandidateIdentity,
  EvidenceChunkRecord,
} from "@/db/repository";
import { crofusionAnswerPolicyCalibrationV1 } from "@/evaluation/fixtures/crofusion-answer-policy-v1";
import { syntheticRetrievalFixtureV1 } from "@/evaluation/fixtures/synthetic-retrieval-v1";
import {
  createEvidenceRetriever,
  type EvidenceRetrievalSource,
} from "@/search/evidence";

function identityKey(candidate: EvidenceCandidateIdentity) {
  return JSON.stringify([
    candidate.chunkId,
    candidate.articleId,
    candidate.articleContentHash,
    candidate.contentHash,
  ]);
}

function calibrationSource(): EvidenceRetrievalSource {
  const fixture = syntheticRetrievalFixtureV1;
  const chunks = fixture.sources.map(
    (source, ordinal): EvidenceChunkRecord => ({
      id: source.id,
      workspaceId: fixture.workspaceId,
      articleId: source.articleId,
      articleContentHash: source.contentHash,
      contentHash: source.contentHash,
      embeddingInputHash: source.contentHash,
      indexGeneration: 1,
      publicationState: "published",
      ordinal,
      title: source.title,
      headingPath: [source.title],
      canonicalUrl: source.canonicalUrl,
      markdown: `## ${source.title}\n\n${source.evidenceText}`,
      evidenceText: source.evidenceText,
      embeddingText: `${source.title}\n\n${source.evidenceText}`,
      sourceLineRange: { start: 1, end: 3 },
      createdAt: fixture.createdAt,
      updatedAt: fixture.createdAt,
    }),
  );
  const embeddings = fixture.sources.map(
    (source): ActiveChunkEmbedding => ({
      workspaceId: fixture.workspaceId,
      chunkId: source.id,
      articleId: source.articleId,
      contentHash: source.contentHash,
      embeddingInputHash: source.contentHash,
      embeddingGenerationId: "synthetic_embedding_v1",
      provider: "deterministic-fixture",
      model: "one-hot-v1",
      dimension: source.vector.length,
      configurationHash: fixture.sourceContentHash,
      vector: source.vector,
    }),
  );
  const identities = new Set(
    chunks.map((chunk) =>
      identityKey({
        chunkId: chunk.id,
        articleId: chunk.articleId,
        articleContentHash: chunk.articleContentHash,
        contentHash: chunk.contentHash,
      }),
    ),
  );
  return {
    async getIndexingState(workspaceId) {
      return workspaceId === fixture.workspaceId
        ? {
            workspaceId,
            generation: 1,
            activeEmbeddingGenerationId: "synthetic_embedding_v1",
            updatedAt: fixture.createdAt,
          }
        : null;
    },
    async listEvidenceChunks(workspaceId) {
      return workspaceId === fixture.workspaceId ? chunks : [];
    },
    async listActiveChunkEmbeddings(workspaceId) {
      return workspaceId === fixture.workspaceId ? embeddings : [];
    },
    async revalidateEvidenceCandidates({ workspaceId, generation, candidates }) {
      return workspaceId === fixture.workspaceId && generation === 1
        ? candidates.filter((candidate) => identities.has(identityKey(candidate)))
        : [];
    },
  };
}

test("derives answer boundaries from the hash-bound production calibration", () => {
  const fixture = crofusionAnswerPolicyCalibrationV1;
  const requiredAnswerScores = fixture.answerable.map(([, score]) => score);
  const requiredAnswerGaps = fixture.answerable.map(([, , gap]) => gap);
  const unsupportedScores = fixture.unsupported.map(([, score]) => score);
  const conflictingArticleGaps = fixture.conflictCanaries.map(
    ([, , gap]) => gap,
  );

  assert.equal(
    fixture.sourceContentHash,
    answerEvidencePolicyCalibration.sourceContentHash,
  );
  assert.equal(
    fixture.embeddingProvider,
    answerEvidencePolicyCalibration.embeddingProvider,
  );
  assert.equal(
    fixture.embeddingModel,
    answerEvidencePolicyCalibration.embeddingModel,
  );
  assert.equal(
    requiredAnswerScores.length,
    answerEvidencePolicyCalibration.requiredAnswerCount,
  );
  assert.equal(
    unsupportedScores.length,
    answerEvidencePolicyCalibration.unsupportedCount,
  );
  assert.equal(
    conflictingArticleGaps.length,
    answerEvidencePolicyCalibration.conflictingCount,
  );
  assert.equal(
    Math.min(...requiredAnswerScores),
    answerEvidencePolicyCalibration.requiredAnswerScoreFloor,
  );
  assert.equal(
    Math.max(...unsupportedScores),
    answerEvidencePolicyCalibration.unsupportedScoreCeiling,
  );
  assert.equal(
    Math.max(...conflictingArticleGaps),
    answerEvidencePolicyCalibration.conflictingArticleGapCeiling,
  );
  assert.ok(
    requiredAnswerScores.every(
      (score) => score >= answerEvidencePolicy.minimumScore,
    ),
  );
  assert.ok(
    requiredAnswerGaps.every(
      (gap) => gap > answerEvidencePolicy.minimumScoreGapAcrossArticles,
    ),
  );
  assert.ok(
    conflictingArticleGaps.every(
      (gap) => gap <= answerEvidencePolicy.minimumScoreGapAcrossArticles,
    ),
  );
  assert.ok(
    unsupportedScores.some(
      (score) => score >= answerEvidencePolicy.minimumScore,
    ),
  );
  assert.equal(
    answerEvidencePolicyCalibration.minimumScoreGuard,
    answerEvidencePolicy.minimumScore,
  );
  assert.equal(
    answerEvidencePolicyCalibration.conflictingArticleGapGuard,
    answerEvidencePolicy.minimumScoreGapAcrossArticles,
  );
  assert.ok(
    answerEvidencePolicyCalibration.conflictingArticleGapGuard >
      answerEvidencePolicyCalibration.conflictingArticleGapCeiling,
  );
  assert.equal(
    answerEvidencePolicyCalibration.unsupportedResolution,
    "generation-abstention",
  );
  assert.equal(answerEvidencePolicyCalibration.designPartnerCalibration, "complete");
});

test("lexical fallback admits the fixed answerable class and rejects unsupported questions", async () => {
  const fixture = syntheticRetrievalFixtureV1;
  const retrieve = createEvidenceRetriever(calibrationSource());
  const answerable = fixture.questions.filter(
    ({ classification }) => classification === "answerable",
  );
  const unsupported = fixture.questions.filter(
    ({ classification }) => classification === "unsupported",
  );

  for (const question of answerable) {
    const results = await retrieve({
      workspaceId: fixture.workspaceId,
      query: question.question,
      mode: "lexical",
      topK: 5,
    });
    assert.ok(results.length > 0, question.id);
    assert.ok(
      results.some(({ sourceId }) =>
        question.acceptedSourceIds.includes(sourceId),
      ),
      question.id,
    );
  }
  for (const question of unsupported) {
    assert.deepEqual(
      await retrieve({
        workspaceId: fixture.workspaceId,
        query: question.question,
        mode: "lexical",
        topK: 5,
      }),
      [],
      question.id,
    );
  }

  assert.equal(answerable.length, 20);
  assert.equal(unsupported.length, 10);
});
