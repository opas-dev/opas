// ABOUTME: Recomputes answer evidence boundaries from the versioned synthetic retrieval fixture.
// ABOUTME: Keeps provisional score and conflict thresholds tied to explicit measured provenance.
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

function rounded(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

test("derives provisional answer boundaries from the hash-bound 50-question fixture", async () => {
  const fixture = syntheticRetrievalFixtureV1;
  const retrieve = createEvidenceRetriever(calibrationSource());
  const requiredAnswerScores: number[] = [];
  const unsupportedScores: number[] = [];
  const conflictingArticleGaps: number[] = [];

  for (const question of fixture.questions) {
    const results = await retrieve({
      workspaceId: fixture.workspaceId,
      query: question.question,
      mode: "hybrid",
      queryVector: question.queryVector,
      topK: 5,
    });
    const strongest = results[0];
    if (question.expectedOutcome === "answer") {
      assert.ok(strongest);
      requiredAnswerScores.push(strongest.score);
    }
    if (question.classification === "unsupported") {
      unsupportedScores.push(strongest?.score ?? 0);
    }
    if (
      question.expectedOutcome === "abstain" &&
      question.id.startsWith("conflicting_")
    ) {
      assert.ok(strongest);
      const competitor = results.find(
        ({ articleId }) => articleId !== strongest.articleId,
      );
      assert.ok(competitor);
      conflictingArticleGaps.push(strongest.score - competitor.score);
    }
  }

  const requiredAnswerScoreFloor = Math.min(...requiredAnswerScores);
  const unsupportedScoreCeiling = Math.max(...unsupportedScores);
  const conflictingArticleGapCeiling = rounded(
    Math.max(...conflictingArticleGaps),
  );
  const minimumScoreMidpoint =
    (requiredAnswerScoreFloor + unsupportedScoreCeiling) / 2;

  assert.deepEqual(
    {
      fixtureId: fixture.id,
      sourceContentHash: fixture.sourceContentHash,
      provenance: fixture.provenance,
      requiredAnswerCount: requiredAnswerScores.length,
      unsupportedCount: unsupportedScores.length,
      conflictingCount: conflictingArticleGaps.length,
      requiredAnswerScoreFloor,
      unsupportedScoreCeiling,
      minimumScoreMidpoint,
      conflictingArticleGapCeiling,
    },
    {
      fixtureId: answerEvidencePolicyCalibration.fixtureId,
      sourceContentHash: answerEvidencePolicyCalibration.sourceContentHash,
      provenance: answerEvidencePolicyCalibration.provenance,
      requiredAnswerCount: 22,
      unsupportedCount: 10,
      conflictingCount: 2,
      requiredAnswerScoreFloor:
        answerEvidencePolicyCalibration.requiredAnswerScoreFloor,
      unsupportedScoreCeiling:
        answerEvidencePolicyCalibration.unsupportedScoreCeiling,
      minimumScoreMidpoint:
        answerEvidencePolicyCalibration.minimumScoreMidpoint,
      conflictingArticleGapCeiling:
        answerEvidencePolicyCalibration.conflictingArticleGapCeiling,
    },
  );
  assert.ok(
    unsupportedScores.every(
      (score) => score < answerEvidencePolicy.minimumScore,
    ),
  );
  assert.ok(
    requiredAnswerScores.every(
      (score) => score >= answerEvidencePolicy.minimumScore,
    ),
  );
  assert.ok(
    conflictingArticleGaps.every(
      (gap) => gap <= answerEvidencePolicy.minimumScoreGapAcrossArticles,
    ),
  );
  assert.equal(
    answerEvidencePolicyCalibration.minimumScoreGuard,
    answerEvidencePolicy.minimumScore,
  );
  assert.ok(
    answerEvidencePolicyCalibration.minimumScoreGuard > minimumScoreMidpoint,
  );
  assert.equal(
    answerEvidencePolicyCalibration.conflictingArticleGapGuard,
    answerEvidencePolicy.minimumScoreGapAcrossArticles,
  );
  assert.ok(
    answerEvidencePolicyCalibration.conflictingArticleGapGuard >
      conflictingArticleGapCeiling,
  );
  assert.equal(answerEvidencePolicyCalibration.designPartnerCalibration, "pending");
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
