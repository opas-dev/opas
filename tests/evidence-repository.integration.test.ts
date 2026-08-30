// ABOUTME: Runs the evidence storage contract against migrated Postgres and local SQLite databases.
// ABOUTME: Verifies generation, lease, vector, fixture, evaluation, and workspace-isolation parity.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { demoIds } from "@/db/demo";
import {
  EvidenceStorageError,
  validateEvaluationRunCompletion,
  validateQuestionSet,
} from "@/db/evidence";
import { createPostgresRepository } from "@/db/postgres/repository";
import { seedPostgres } from "@/db/postgres/seed";
import type {
  ArticleEvidenceCommit,
  EmbeddingGeneration,
  EvaluationRunCompletion,
  Repository,
  SavedQuestionSet,
} from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteRepository } from "@/db/sqlite/repository";
import { seedD1 } from "@/db/sqlite/seed";

const firstSourceHash = "1".repeat(64);
const secondSourceHash = "2".repeat(64);
const firstEmbeddingInputHash = "a".repeat(64);
const secondEmbeddingInputHash = "b".repeat(64);
const articleContentHash = "c".repeat(64);
const changedArticleContentHash = "d".repeat(64);
const configurationHash = "e".repeat(64);
const questionSourceHash = "f".repeat(64);
const startedAt = new Date("2026-08-30T10:00:00.000Z");
const raceWorkspaceId = "workspace_embedding_race";
const raceCategoryId = "category_embedding_race";
const raceArticleId = "article_embedding_race";
const embeddingMetadata = {
  provider: "openai-compatible" as const,
  model: "test-embedding-v1",
  dimension: 3,
  configuration: {
    dimensionsParameter: false,
    endpoint: "https://embeddings.example.test/v1/embeddings",
  },
  configurationHash,
};

test("evidence validation rejects invalid fixture and evaluation records", () => {
  const invalidQuestionSet = {
    id: "invalid_questions",
    workspaceId: demoIds.workspace,
    name: "Invalid questions",
    version: 1,
    sourceContentHash: questionSourceHash,
    questions: [
      {
        id: "invalid_question",
        classification: "invented",
        question: "Can this classification be stored?",
        expectedOutcome: "answer",
        acceptedSourceIds: ["chunk_intro"],
        sourceContentHashes: [firstSourceHash],
      },
    ],
    createdAt: startedAt,
  } as unknown as SavedQuestionSet;
  assert.throws(
    () => validateQuestionSet(invalidQuestionSet),
    EvidenceStorageError,
  );

  const cyclicResults: { self?: unknown } = {};
  cyclicResults.self = cyclicResults;
  assert.throws(
    () =>
      validateEvaluationRunCompletion({
        id: "invalid_evaluation",
        workspaceId: demoIds.workspace,
        status: "completed",
        results: cyclicResults,
        completedAt: startedAt,
      } satisfies EvaluationRunCompletion),
    EvidenceStorageError,
  );
});

function generation(): EmbeddingGeneration {
  return {
    id: "embedding_generation_pilot",
    workspaceId: demoIds.workspace,
    provider: embeddingMetadata.provider,
    model: embeddingMetadata.model,
    dimension: embeddingMetadata.dimension,
    configurationHash,
    status: "building",
    createdAt: startedAt,
    activatedAt: null,
    retiredAt: null,
  };
}

function evidenceCommit(): ArticleEvidenceCommit {
  return {
    workspaceId: demoIds.workspace,
    articleId: demoIds.publishedArticle,
    categorySlug: "getting-started",
    articleContentHash,
    chunks: [
      {
        id: "chunk_intro",
        contentHash: firstSourceHash,
        embeddingInputHash: firstEmbeddingInputHash,
        ordinal: 0,
        title: "Welcome to OPAS",
        headingPath: [],
        canonicalUrl: "https://docs.example.test/getting-started/welcome",
        markdown: "Welcome to the help center.",
        evidenceText: "Welcome to the help center.",
        embeddingText: "Welcome to OPAS\n\nWelcome to the help center.",
        sourceLineRange: { start: 3, end: 3 },
      },
      {
        id: "chunk_install",
        contentHash: secondSourceHash,
        embeddingInputHash: secondEmbeddingInputHash,
        ordinal: 1,
        title: "Welcome to OPAS",
        headingPath: ["Install"],
        canonicalUrl: "https://docs.example.test/getting-started/welcome",
        markdown: "## Install\n\nRun the installer.",
        evidenceText: "Install\nRun the installer.",
        embeddingText: "Welcome to OPAS > Install\n\nInstall\nRun the installer.",
        sourceLineRange: { start: 5, end: 7 },
      },
    ],
    job: {
      id: "embedding_job_initial",
      embeddingGenerationId: null,
      maximumAttempts: 3,
      availableAt: startedAt,
    },
  };
}

async function exerciseEvidenceRepository(repository: Repository, label: string) {
  assert.equal(await repository.getIndexingState(demoIds.workspace), null);
  const initialCandidates = await repository.listUnindexedPublishedArticles(
    demoIds.workspace,
    20,
  );
  const initialArticle = initialCandidates.find(
    (article) => article.id === demoIds.publishedArticle,
  );
  assert.ok(initialArticle, `${label} did not list the unindexed seed article`);
  const staleInitialization = {
    article: { ...initialArticle, title: `${initialArticle.title} stale` },
    evidence: evidenceCommit(),
    initializedAt: startedAt,
  };
  assert.equal(
    await repository.initializeArticleEvidence(staleInitialization),
    false,
    `${label} initialized evidence from a stale article snapshot`,
  );
  assert.equal(await repository.getIndexingState(demoIds.workspace), null);
  assert.equal(
    await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_initial"),
    null,
  );
  assert.deepEqual(await repository.listEvidenceChunks(demoIds.workspace), []);
  assert.equal(
    (await repository.getArticle(demoIds.workspace, demoIds.publishedArticle))
      ?.contentHash,
    null,
  );
  await assert.rejects(
    repository.createEmbeddingGeneration({
      ...generation(),
      id: "embedding_generation_invalid",
      status: "active",
      activatedAt: startedAt,
    }),
    EvidenceStorageError,
  );
  await repository.createEmbeddingGeneration(generation());

  assert.equal(
    await repository.initializeArticleEvidence({
      article: initialArticle,
      evidence: evidenceCommit(),
      initializedAt: startedAt,
    }),
    true,
  );
  const committedState = await repository.getIndexingState(demoIds.workspace);
  assert.ok(committedState);
  assert.equal(committedState.generation, 1, `${label} did not create generation one`);
  assert.equal(committedState.activeEmbeddingGenerationId, null);
  assert.equal(
    await repository.initializeArticleEvidence({
      article: initialArticle,
      evidence: { ...evidenceCommit(), job: { ...evidenceCommit().job, id: "embedding_job_repeat" } },
      initializedAt: new Date(startedAt.getTime() + 1),
    }),
    false,
    `${label} repeated evidence initialization for an indexed revision`,
  );
  assert.equal((await repository.getIndexingState(demoIds.workspace))?.generation, 1);
  assert.equal(
    await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_repeat"),
    null,
  );
  assert.equal((await repository.listEvidenceChunks(demoIds.workspace)).length, 2);
  assert.equal(
    (await repository.getArticle(demoIds.workspace, demoIds.publishedArticle))
      ?.contentHash,
    articleContentHash,
  );
  const reconciledGeneration = await repository.reconcileEmbeddingGeneration({
    workspaceId: demoIds.workspace,
    metadata: embeddingMetadata,
    reconciledAt: startedAt,
  });
  assert.equal(reconciledGeneration.id, "embedding_generation_pilot");
  assert.equal(
    (
      await repository.reconcileEmbeddingGeneration({
        workspaceId: demoIds.workspace,
        metadata: embeddingMetadata,
        reconciledAt: new Date(startedAt.getTime() + 1),
      })
    ).id,
    reconciledGeneration.id,
    `${label} created duplicate building generations for one configuration`,
  );
  await assert.rejects(
    repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_oversized",
      embeddingGenerationId: reconciledGeneration.id,
      embeddings: Array.from({ length: 8_000 }, (_, index) => ({
        chunkId: `chunk_oversized_${index}_${"x".repeat(150)}`,
        contentHash: firstSourceHash,
        embeddingInputHash: firstEmbeddingInputHash,
        vector: [1, 0, 0],
      })),
      checkedAt: startedAt,
    }),
    EvidenceStorageError,
    `${label} accepted a persistence batch beyond the portable byte ceiling`,
  );

  const chunks = await repository.listEvidenceChunks(demoIds.workspace);
  assert.deepEqual(
    chunks.map((chunk) => ({
      id: chunk.id,
      articleContentHash: chunk.articleContentHash,
      indexGeneration: chunk.indexGeneration,
      headingPath: chunk.headingPath,
      sourceLineRange: chunk.sourceLineRange,
      publicationState: chunk.publicationState,
    })),
    [
      {
        id: "chunk_intro",
        articleContentHash,
        indexGeneration: 1,
        headingPath: [],
        sourceLineRange: { start: 3, end: 3 },
        publicationState: "published",
      },
      {
        id: "chunk_install",
        articleContentHash,
        indexGeneration: 1,
        headingPath: ["Install"],
        sourceLineRange: { start: 5, end: 7 },
        publicationState: "published",
      },
    ],
  );
  const candidateIdentities = [chunks[1], chunks[0]].map((chunk) => ({
    chunkId: chunk.id,
    articleId: chunk.articleId,
    articleContentHash: chunk.articleContentHash,
    contentHash: chunk.contentHash,
  }));
  assert.deepEqual(
    await repository.revalidateEvidenceCandidates({
      workspaceId: demoIds.workspace,
      generation: 1,
      candidates: [
        candidateIdentities[0],
        { ...candidateIdentities[1], contentHash: "0".repeat(64) },
        candidateIdentities[1],
      ],
    }),
    candidateIdentities,
  );
  assert.deepEqual(
    await repository.revalidateEvidenceCandidates({
      workspaceId: demoIds.workspace,
      generation: 0,
      candidates: candidateIdentities,
    }),
    [],
    `${label} revalidated candidates from a stale workspace generation`,
  );
  assert.deepEqual(
    await repository.revalidateEvidenceCandidates({
      workspaceId: "workspace_other",
      generation: 1,
      candidates: candidateIdentities,
    }),
    [],
    `${label} revalidated candidates across workspaces`,
  );

  const [raceCandidate] = await repository.listUnindexedPublishedArticles(
    raceWorkspaceId,
    1,
  );
  assert.ok(raceCandidate, `${label} did not list the race article`);
  const raceInitializationEvidence = (jobId: string): ArticleEvidenceCommit => ({
    workspaceId: raceWorkspaceId,
    articleId: raceArticleId,
    categorySlug: "race",
    articleContentHash: "7".repeat(64),
    chunks: [],
    job: {
      id: jobId,
      embeddingGenerationId: null,
      maximumAttempts: 3,
      availableAt: startedAt,
    },
  });
  const raceResults = await Promise.all([
    repository.initializeArticleEvidence({
      article: raceCandidate,
      evidence: raceInitializationEvidence("embedding_job_race_initial_a"),
      initializedAt: startedAt,
    }),
    repository.initializeArticleEvidence({
      article: raceCandidate,
      evidence: raceInitializationEvidence("embedding_job_race_initial_b"),
      initializedAt: startedAt,
    }),
  ]);
  assert.deepEqual(
    [...raceResults].sort(),
    [false, true],
    `${label} did not serialize concurrent evidence initialization`,
  );
  assert.equal((await repository.getIndexingState(raceWorkspaceId))?.generation, 1);
  assert.equal(
    [
      await repository.getEmbeddingJob(
        raceWorkspaceId,
        "embedding_job_race_initial_a",
      ),
      await repository.getEmbeddingJob(
        raceWorkspaceId,
        "embedding_job_race_initial_b",
      ),
    ].filter(Boolean).length,
    1,
  );
  assert.deepEqual(await repository.listEvidenceChunks(raceWorkspaceId), []);
  assert.equal(
    (await repository.getArticle(raceWorkspaceId, raceArticleId))?.contentHash,
    "7".repeat(64),
  );

  await repository.commitArticleEvidence({
    workspaceId: raceWorkspaceId,
    articleId: raceArticleId,
    categorySlug: "race",
    articleContentHash: "8".repeat(64),
    chunks: [
      {
        id: "chunk_embedding_race",
        contentHash: "9".repeat(64),
        embeddingInputHash: "a".repeat(64),
        ordinal: 0,
        title: "Race evidence",
        headingPath: [],
        canonicalUrl: "https://docs.example.test/race/article",
        markdown: "Race evidence.",
        evidenceText: "Race evidence.",
        embeddingText: "Race evidence\n\nRace evidence.",
        sourceLineRange: { start: 1, end: 1 },
      },
    ],
    job: {
      id: "embedding_job_race",
      embeddingGenerationId: null,
      maximumAttempts: 3,
      availableAt: startedAt,
    },
  });
  const raceGeneration = await repository.reconcileEmbeddingGeneration({
    workspaceId: raceWorkspaceId,
    metadata: embeddingMetadata,
    reconciledAt: startedAt,
  });

  const firstLeaseExpiry = new Date(startedAt.getTime() + 30_000);
  const [firstLease, raceLease] = await Promise.all([
    repository.claimEmbeddingJob({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: "embedding_generation_pilot",
      claimedAt: startedAt,
      leaseExpiresAt: firstLeaseExpiry,
      leaseToken: "lease_initial",
    }),
    repository.claimEmbeddingJob({
      workspaceId: raceWorkspaceId,
      embeddingGenerationId: raceGeneration.id,
      claimedAt: startedAt,
      leaseExpiresAt: firstLeaseExpiry,
      leaseToken: "lease_initial",
    }),
  ]);
  assert.equal(firstLease?.id, "embedding_job_initial");
  assert.equal(raceLease?.id, "embedding_job_race");
  assert.equal(
    await repository.getEmbeddingJobWork({
      workspaceId: demoIds.workspace,
      id: "embedding_job_race",
      leaseToken: "lease_initial",
      checkedAt: new Date(startedAt.getTime() + 100),
    }),
    null,
    `${label} crossed workspace boundaries for a shared lease token`,
  );
  assert.equal(
    await repository.failEmbeddingJob({
      workspaceId: raceWorkspaceId,
      id: "embedding_job_race",
      leaseToken: "lease_initial",
      checkedAt: new Date(startedAt.getTime() + 100),
      errorCode: "provider-unavailable",
    }),
    true,
  );
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_initial"))?.status,
    "leased",
  );
  assert.equal(firstLease?.attempts, 1);
  const initialWork = await repository.getEmbeddingJobWork({
    workspaceId: demoIds.workspace,
    id: "embedding_job_initial",
    leaseToken: "lease_initial",
    checkedAt: new Date(startedAt.getTime() + 250),
  });
  assert.equal(initialWork?.completedChunkCount, 0);
  assert.equal(initialWork?.totalChunkCount, 2);
  assert.deepEqual(initialWork?.chunks.map((chunk) => chunk.id), [
    "chunk_intro",
    "chunk_install",
  ]);
  const repeatedLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    claimedAt: new Date(startedAt.getTime() + 500),
    leaseExpiresAt: new Date(firstLeaseExpiry.getTime() + 30_000),
    leaseToken: "lease_initial",
  });
  assert.equal(repeatedLease?.id, "embedding_job_initial");
  assert.equal(repeatedLease?.attempts, 1, `${label} claimed a second job for one lease token`);
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_initial"))
      ?.leaseExpiresAt?.getTime(),
    firstLeaseExpiry.getTime(),
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_initial",
      completedChunkCount: 1,
      checkedAt: new Date(startedAt.getTime() + 1_000),
      leaseExpiresAt: new Date(startedAt.getTime() + 31_000),
    }),
    false,
    `${label} accepted a checkpoint without exact stored vectors`,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_initial",
      completedChunkCount: 0,
      checkedAt: new Date(startedAt.getTime() + 2_000),
      leaseExpiresAt: new Date(startedAt.getTime() + 32_000),
    }),
    true,
    `${label} rejected an idempotent zero checkpoint`,
  );

  const retryAt = new Date(startedAt.getTime() + 60_000);
  assert.equal(
    await repository.retryEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_initial",
      checkedAt: new Date(startedAt.getTime() + 3_000),
      availableAt: retryAt,
      errorCode: "provider-unavailable",
    }),
    true,
  );
  assert.equal(
    await repository.claimEmbeddingJob({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: "embedding_generation_pilot",
      claimedAt: new Date(retryAt.getTime() - 1),
      leaseExpiresAt: new Date(retryAt.getTime() + 30_000),
      leaseToken: "lease_too_early",
    }),
    null,
  );

  const secondLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    claimedAt: retryAt,
    leaseExpiresAt: new Date(retryAt.getTime() + 1_000),
    leaseToken: "lease_retry",
  });
  assert.equal(secondLease?.attempts, 2);
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_initial"))
      ?.checkpoint,
    0,
  );

  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_initial",
      embeddingGenerationId: "embedding_generation_pilot",
      embeddings: [
        {
          chunkId: "chunk_intro",
          contentHash: firstSourceHash,
          embeddingInputHash: firstEmbeddingInputHash,
          vector: [1, 0, 0],
        },
      ],
      checkedAt: retryAt,
    }),
    false,
    `${label} accepted a stale lease token after retry`,
  );
  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_retry",
      embeddingGenerationId: "embedding_generation_pilot",
      embeddings: [
        {
          chunkId: "chunk_intro",
          contentHash: firstSourceHash,
          embeddingInputHash: firstEmbeddingInputHash,
          vector: [1, 0, 0],
        },
      ],
      checkedAt: new Date(retryAt.getTime() + 500),
    }),
    true,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_retry",
      completedChunkCount: 1,
      checkedAt: new Date(retryAt.getTime() + 750),
      leaseExpiresAt: new Date(retryAt.getTime() + 1_500),
    }),
    true,
  );
  assert.equal(
    await repository.completeEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_retry",
      checkedAt: new Date(retryAt.getTime() + 800),
    }),
    false,
    `${label} completed a job without full current chunk coverage`,
  );
  const reclaimedLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    claimedAt: new Date(retryAt.getTime() + 1_500),
    leaseExpiresAt: new Date(retryAt.getTime() + 31_500),
    leaseToken: "lease_reclaimed",
  });
  assert.equal(reclaimedLease?.id, "embedding_job_initial");
  assert.equal(reclaimedLease?.attempts, 3);
  const reclaimedWork = await repository.getEmbeddingJobWork({
    workspaceId: demoIds.workspace,
    id: "embedding_job_initial",
    leaseToken: "lease_reclaimed",
    checkedAt: new Date(retryAt.getTime() + 1_600),
  });
  assert.equal(reclaimedWork?.completedChunkCount, 1);
  assert.deepEqual(reclaimedWork?.chunks.map((chunk) => chunk.id), ["chunk_install"]);
  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_retry",
      embeddingGenerationId: "embedding_generation_pilot",
      embeddings: [
        {
          chunkId: "chunk_install",
          contentHash: secondSourceHash,
          embeddingInputHash: secondEmbeddingInputHash,
          vector: [0, 1, 0],
        },
      ],
      checkedAt: new Date(retryAt.getTime() + 1_600),
    }),
    false,
  );
  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_reclaimed",
      embeddingGenerationId: "embedding_generation_pilot",
      embeddings: [
        {
          chunkId: "chunk_install",
          contentHash: secondSourceHash,
          embeddingInputHash: secondEmbeddingInputHash,
          vector: [0, 1, 0],
        },
      ],
      checkedAt: new Date(retryAt.getTime() + 1_700),
    }),
    true,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_reclaimed",
      completedChunkCount: 2,
      checkedAt: new Date(retryAt.getTime() + 1_800),
      leaseExpiresAt: new Date(retryAt.getTime() + 61_800),
    }),
    true,
  );
  assert.equal(
    await repository.completeEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_reclaimed",
      checkedAt: new Date(retryAt.getTime() + 1_900),
    }),
    true,
  );
  assert.equal(
    await repository.activateEmbeddingGeneration({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: "embedding_generation_pilot",
      activatedAt: new Date(retryAt.getTime() + 2_000),
      metadata: embeddingMetadata,
    }),
    true,
  );

  assert.equal(
    (await repository.getIndexingState(demoIds.workspace))
      ?.activeEmbeddingGenerationId,
    "embedding_generation_pilot",
  );
  assert.deepEqual(
    (await repository.listActiveChunkEmbeddings(demoIds.workspace)).map(
      (embedding) => ({ id: embedding.chunkId, vector: embedding.vector }),
    ),
    [
      { id: "chunk_intro", vector: [1, 0, 0] },
      { id: "chunk_install", vector: [0, 1, 0] },
    ],
  );

  const changedCommit = evidenceCommit();
  changedCommit.articleContentHash = changedArticleContentHash;
  changedCommit.chunks = [
    {
      ...changedCommit.chunks[0],
      ordinal: 1,
    },
    {
      ...changedCommit.chunks[1],
      ordinal: 0,
      contentHash: "3".repeat(64),
      embeddingInputHash: "4".repeat(64),
      markdown: "## Install\n\nRun the updated installer.",
      evidenceText: "Install\nRun the updated installer.",
      embeddingText: "Welcome to OPAS > Install\n\nInstall\nRun the updated installer.",
    },
  ];
  changedCommit.job = {
    ...changedCommit.job,
    id: "embedding_job_changed",
    maximumAttempts: 1,
  };

  const changedState = await repository.commitArticleEvidence(changedCommit);
  assert.equal(changedState.generation, 2);
  await repository.reconcileEmbeddingGeneration({
    workspaceId: demoIds.workspace,
    metadata: embeddingMetadata,
    reconciledAt: new Date(retryAt.getTime() + 2_250),
  });
  const incompleteActivationAt = new Date(retryAt.getTime() + 2_500);
  assert.equal(
    await repository.activateEmbeddingGeneration({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: "embedding_generation_pilot",
      activatedAt: incompleteActivationAt,
      metadata: embeddingMetadata,
    }),
    false,
    `${label} reactivated a generation with missing current vectors`,
  );
  assert.equal(
    (await repository.getActiveEmbeddingGeneration(demoIds.workspace))?.activatedAt?.getTime(),
    retryAt.getTime() + 2_000,
  );
  assert.deepEqual(
    (await repository.listEvidenceChunks(demoIds.workspace)).map((chunk) => chunk.id),
    ["chunk_install", "chunk_intro"],
  );
  assert.deepEqual(
    (await repository.listActiveChunkEmbeddings(demoIds.workspace)).map(
      (embedding) => ({ id: embedding.chunkId, vector: embedding.vector }),
    ),
    [],
    `${label} exposed part of an article before its exact job completed`,
  );

  const changedClaimedAt = new Date(retryAt.getTime() + 3_000);
  const changedLeaseExpiry = new Date(changedClaimedAt.getTime() + 1_000);
  assert.equal(
    (
      await repository.claimEmbeddingJob({
        workspaceId: demoIds.workspace,
        embeddingGenerationId: "embedding_generation_pilot",
        claimedAt: changedClaimedAt,
        leaseExpiresAt: changedLeaseExpiry,
        leaseToken: "lease_changed",
      })
    )?.attempts,
    1,
  );
  const changedWork = await repository.getEmbeddingJobWork({
    workspaceId: demoIds.workspace,
    id: "embedding_job_changed",
    leaseToken: "lease_changed",
    checkedAt: new Date(changedClaimedAt.getTime() + 250),
  });
  assert.equal(changedWork?.completedChunkCount, 1);
  assert.equal(changedWork?.totalChunkCount, 2);
  assert.deepEqual(changedWork?.chunks.map((chunk) => chunk.id), ["chunk_install"]);
  assert.equal(
    await repository.claimEmbeddingJob({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: "embedding_generation_pilot",
      claimedAt: changedLeaseExpiry,
      leaseExpiresAt: new Date(changedLeaseExpiry.getTime() + 1_000),
      leaseToken: "lease_after_limit",
    }),
    null,
  );
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_changed"))
      ?.status,
    "failed",
    `${label} left an expired final-attempt lease stuck`,
  );

  const restoredCommit = evidenceCommit();
  restoredCommit.job.id = "embedding_job_restored";
  restoredCommit.job.availableAt = new Date(retryAt.getTime() + 5_000);
  const restoredState = await repository.commitArticleEvidence(restoredCommit);
  assert.equal(restoredState.generation, 3);
  await repository.reconcileEmbeddingGeneration({
    workspaceId: demoIds.workspace,
    metadata: embeddingMetadata,
    reconciledAt: restoredCommit.job.availableAt,
  });
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_initial"))
      ?.status,
    "pending",
    `${label} did not reset the exact A job when content returned after A-B-A`,
  );
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_restored"))
      ?.status,
    "superseded",
  );
  const restoredLeaseExpiry = new Date(retryAt.getTime() + 35_000);
  const restoredLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    claimedAt: restoredCommit.job.availableAt,
    leaseExpiresAt: restoredLeaseExpiry,
    leaseToken: "lease_restored",
  });
  assert.equal(restoredLease?.id, "embedding_job_initial");
  const restoredWork = await repository.getEmbeddingJobWork({
    workspaceId: demoIds.workspace,
    id: "embedding_job_initial",
    leaseToken: "lease_restored",
    checkedAt: new Date(restoredCommit.job.availableAt.getTime() + 100),
  });
  assert.equal(restoredWork?.completedChunkCount, 1);
  assert.deepEqual(restoredWork?.chunks.map((chunk) => chunk.id), ["chunk_install"]);
  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_restored",
      embeddingGenerationId: "embedding_generation_pilot",
      embeddings: [
        {
          chunkId: "chunk_install",
          contentHash: secondSourceHash,
          embeddingInputHash: secondEmbeddingInputHash,
          vector: [0, 1, 0],
        },
      ],
      checkedAt: new Date(restoredCommit.job.availableAt.getTime() + 200),
    }),
    true,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_restored",
      completedChunkCount: 2,
      checkedAt: new Date(restoredCommit.job.availableAt.getTime() + 300),
      leaseExpiresAt: new Date(restoredCommit.job.availableAt.getTime() + 60_000),
    }),
    true,
  );
  assert.equal(
    await repository.completeEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_restored",
      checkedAt: new Date(restoredCommit.job.availableAt.getTime() + 400),
    }),
    true,
  );
  assert.equal(
    (await repository.listActiveChunkEmbeddings(demoIds.workspace)).length,
    2,
  );

  const bulkChunks = Array.from({ length: 120 }, (_, ordinal) => ({
    id: `chunk_bulk_${ordinal}`,
    contentHash: (ordinal % 16).toString(16).repeat(64),
    embeddingInputHash: ((ordinal + 7) % 16).toString(16).repeat(64),
    ordinal,
    title: "Bulk evidence",
    headingPath: ["Bulk", String(ordinal)],
    canonicalUrl: "https://docs.example.test/getting-started/welcome",
    markdown: `Bulk evidence ${ordinal}.`,
    evidenceText: `Bulk evidence ${ordinal}.`,
    embeddingText: `Bulk evidence\n\nBulk evidence ${ordinal}.`,
    sourceLineRange: { start: ordinal + 1, end: ordinal + 1 },
  }));
  const bulkState = await repository.commitArticleEvidence({
    workspaceId: demoIds.workspace,
    articleId: demoIds.publishedArticle,
    categorySlug: "getting-started",
    articleContentHash: "5".repeat(64),
    chunks: bulkChunks,
    job: {
      id: "embedding_job_bulk",
      embeddingGenerationId: null,
      maximumAttempts: 3,
      availableAt: new Date(retryAt.getTime() + 6_000),
    },
  });
  assert.equal(bulkState.generation, 4);
  await repository.reconcileEmbeddingGeneration({
    workspaceId: demoIds.workspace,
    metadata: embeddingMetadata,
    reconciledAt: new Date(retryAt.getTime() + 6_000),
  });
  const bulkLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    claimedAt: new Date(retryAt.getTime() + 6_000),
    leaseExpiresAt: new Date(retryAt.getTime() + 36_000),
    leaseToken: "lease_bulk",
  });
  assert.equal(bulkLease?.id, "embedding_job_bulk");
  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: "embedding_job_bulk",
      leaseToken: "lease_bulk",
      embeddingGenerationId: "embedding_generation_pilot",
      embeddings: bulkChunks.map((chunk, ordinal) => ({
        chunkId: chunk.id,
        contentHash: chunk.contentHash,
        embeddingInputHash: chunk.embeddingInputHash,
        vector: [ordinal, 0, 0],
      })),
      checkedAt: new Date(retryAt.getTime() + 6_100),
    }),
    true,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_bulk",
      leaseToken: "lease_bulk",
      completedChunkCount: bulkChunks.length,
      checkedAt: new Date(retryAt.getTime() + 6_200),
      leaseExpiresAt: new Date(retryAt.getTime() + 66_000),
    }),
    true,
  );
  assert.equal(
    await repository.completeEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_bulk",
      leaseToken: "lease_bulk",
      checkedAt: new Date(retryAt.getTime() + 6_300),
    }),
    true,
  );
  assert.equal(
    await repository.activateEmbeddingGeneration({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: "embedding_generation_pilot",
      activatedAt: new Date(retryAt.getTime() + 7_000),
      metadata: embeddingMetadata,
    }),
    true,
  );
  assert.equal(
    (await repository.listActiveChunkEmbeddings(demoIds.workspace)).length,
    bulkChunks.length,
  );
  const replacementMetadata = {
    ...embeddingMetadata,
    model: "test-embedding-v2",
    configurationHash: "6".repeat(64),
  };
  const replacementGeneration = await repository.reconcileEmbeddingGeneration({
    workspaceId: demoIds.workspace,
    metadata: replacementMetadata,
    reconciledAt: new Date(retryAt.getTime() + 7_100),
  });
  assert.notEqual(replacementGeneration.id, "embedding_generation_pilot");
  assert.equal(
    (
      await repository.reconcileEmbeddingGeneration({
        workspaceId: demoIds.workspace,
        metadata: replacementMetadata,
        reconciledAt: new Date(retryAt.getTime() + 7_150),
      })
    ).id,
    replacementGeneration.id,
  );
  const replacementLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: replacementGeneration.id,
    claimedAt: new Date(retryAt.getTime() + 7_200),
    leaseExpiresAt: new Date(retryAt.getTime() + 37_200),
    leaseToken: "lease_replacement",
  });
  assert.ok(replacementLease);
  assert.equal(
    await repository.saveEmbeddingJobBatch({
      workspaceId: demoIds.workspace,
      id: replacementLease.id,
      leaseToken: "lease_replacement",
      embeddingGenerationId: replacementGeneration.id,
      embeddings: bulkChunks.map((chunk, ordinal) => ({
        chunkId: chunk.id,
        contentHash: chunk.contentHash,
        embeddingInputHash: chunk.embeddingInputHash,
        vector: [0, ordinal, 0],
      })),
      checkedAt: new Date(retryAt.getTime() + 7_300),
    }),
    true,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: replacementLease.id,
      leaseToken: "lease_replacement",
      completedChunkCount: bulkChunks.length,
      checkedAt: new Date(retryAt.getTime() + 7_400),
      leaseExpiresAt: new Date(retryAt.getTime() + 67_400),
    }),
    true,
  );
  assert.equal(
    await repository.completeEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: replacementLease.id,
      leaseToken: "lease_replacement",
      checkedAt: new Date(retryAt.getTime() + 7_500),
    }),
    true,
  );
  assert.equal(
    await repository.activateEmbeddingGeneration({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: replacementGeneration.id,
      activatedAt: new Date(retryAt.getTime() + 7_600),
      metadata: replacementMetadata,
    }),
    true,
  );
  assert.equal(
    (await repository.getIndexingState(demoIds.workspace))
      ?.activeEmbeddingGenerationId,
    replacementGeneration.id,
  );

  const failingMetadata = {
    ...embeddingMetadata,
    model: "test-embedding-failure",
    configurationHash: "7".repeat(64),
  };
  const failingGeneration = await repository.reconcileEmbeddingGeneration({
    workspaceId: demoIds.workspace,
    metadata: failingMetadata,
    reconciledAt: new Date(retryAt.getTime() + 7_700),
  });
  const failingLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: failingGeneration.id,
    claimedAt: new Date(retryAt.getTime() + 7_800),
    leaseExpiresAt: new Date(retryAt.getTime() + 37_800),
    leaseToken: "lease_failure",
  });
  assert.ok(failingLease);
  assert.equal(
    await repository.failEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: failingLease.id,
      leaseToken: "lease_failure",
      checkedAt: new Date(retryAt.getTime() + 7_900),
      errorCode: "provider-unavailable",
    }),
    true,
  );
  assert.equal(
    await repository.activateEmbeddingGeneration({
      workspaceId: demoIds.workspace,
      embeddingGenerationId: failingGeneration.id,
      activatedAt: new Date(retryAt.getTime() + 8_000),
      metadata: failingMetadata,
    }),
    false,
  );
  assert.equal(
    (await repository.getIndexingState(demoIds.workspace))
      ?.activeEmbeddingGenerationId,
    replacementGeneration.id,
    `${label} displaced the active generation after provider failure`,
  );
  const returnedConfigurationGeneration =
    await repository.reconcileEmbeddingGeneration({
      workspaceId: demoIds.workspace,
      metadata: embeddingMetadata,
      reconciledAt: new Date(retryAt.getTime() + 8_100),
    });
  assert.notEqual(
    returnedConfigurationGeneration.id,
    "embedding_generation_pilot",
    `${label} reused a retired generation when its configuration returned`,
  );

  const bulkInvalidatedState = await repository.invalidateArticleEvidence(
    demoIds.workspace,
    demoIds.publishedArticle,
    new Date(retryAt.getTime() + 9_000),
  );
  assert.equal(bulkInvalidatedState.generation, 5);
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_bulk"))?.status,
    "completed",
  );
  assert.deepEqual(await repository.listActiveChunkEmbeddings(demoIds.workspace), []);

  await repository.saveQuestionSet({
    id: "question_set_pilot_v1",
    workspaceId: demoIds.workspace,
    name: "Pilot questions",
    version: 1,
    sourceContentHash: questionSourceHash,
    questions: [
      {
        id: "question_answerable",
        classification: "answerable",
        question: "How do I install OPAS?",
        expectedOutcome: "answer",
        acceptedSourceIds: ["chunk_install"],
        sourceContentHashes: [secondSourceHash],
      },
      {
        id: "question_unsupported",
        classification: "unsupported",
        question: "Does OPAS ship a ticket inbox?",
        expectedOutcome: "abstain",
        acceptedSourceIds: [],
        sourceContentHashes: [questionSourceHash],
      },
    ],
    createdAt: startedAt,
  });
  assert.equal(
    (await repository.getQuestionSet(demoIds.workspace, "question_set_pilot_v1"))
      ?.questions.length,
    2,
  );

  await repository.startEvaluationRun({
    id: "evaluation_run_pilot",
    workspaceId: demoIds.workspace,
    questionSetId: "question_set_pilot_v1",
    indexGeneration: 5,
    embeddingGenerationId: "embedding_generation_pilot",
    retrievalMode: "orama-hybrid",
    provider: "test-provider",
    model: "test-answer-v1",
    startedAt,
  });
  await repository.finishEvaluationRun({
    id: "evaluation_run_pilot",
    workspaceId: demoIds.workspace,
    status: "completed",
    results: {
      classes: {
        answerable: { passed: 1, total: 1 },
        unsupported: { passed: 1, total: 1 },
      },
    },
    completedAt: new Date(startedAt.getTime() + 5_000),
  });
  const run = await repository.getEvaluationRun(
    demoIds.workspace,
    "evaluation_run_pilot",
  );
  assert.equal(run?.status, "completed");
  assert.deepEqual(run?.results, {
    classes: {
      answerable: { passed: 1, total: 1 },
      unsupported: { passed: 1, total: 1 },
    },
  });
}

test("evidence repository contract passes on Postgres", { timeout: 120_000 }, async () => {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });

  try {
    await migratePostgres(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
    });
    await seedPostgres(database);
    await pool.query(
      "insert into workspaces (id, slug, name) values ($1, $2, $3)",
      [raceWorkspaceId, "embedding-race", "Embedding race"],
    );
    await pool.query(
      "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
      [raceCategoryId, raceWorkspaceId, "race", "Race"],
    );
    await pool.query(
      `insert into articles
        (id, workspace_id, category_id, slug, title, mdx, status)
       values ($1, $2, $3, $4, $5, $6, 'published')`,
      [
        raceArticleId,
        raceWorkspaceId,
        raceCategoryId,
        "article",
        "Race article",
        "Race evidence.",
      ],
    );
    await exerciseEvidenceRepository(createPostgresRepository(database), "Postgres");
    await pool.query(
      "insert into workspaces (id, slug, name) values ($1, $2, $3)",
      ["workspace_other", "other", "Other"],
    );
    await assert.rejects(
      pool.query(
        "insert into workspace_index_states (workspace_id, generation, active_embedding_generation_id) values ($1, $2, $3)",
        ["workspace_other", 0, "embedding_generation_pilot"],
      ),
      /foreign key constraint/u,
    );
    await pool.query(
      "insert into saved_question_sets (id, workspace_id, name, version, source_content_hash, questions) values ($1, $2, $3, $4, $5, $6::jsonb)",
      ["question_set_other", "workspace_other", "Other", 1, questionSourceHash, "[]"],
    );
    await assert.rejects(
      pool.query(
        "insert into evaluation_runs (id, workspace_id, question_set_id, index_generation, embedding_generation_id, retrieval_mode) values ($1, $2, $3, $4, $5, $6)",
        [
          "evaluation_run_cross_workspace",
          "workspace_other",
          "question_set_other",
          0,
          "embedding_generation_pilot",
          "lexical",
        ],
      ),
      /foreign key constraint/u,
    );
    await pool.query("delete from workspaces where id = $1", ["workspace_other"]);
    await pool.query("delete from workspaces where id = $1", [demoIds.workspace]);
    await pool.query("delete from workspaces where id = $1", [raceWorkspaceId]);
    assert.equal(
      Number((await pool.query("select count(*) from embedding_generations")).rows[0].count),
      0,
    );
    assert.equal(
      Number((await pool.query("select count(*) from evaluation_runs")).rows[0].count),
      0,
    );
  } finally {
    await pool.end();
    await container.stop();
  }
});

test("evidence repository contract passes on local SQLite", async () => {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });

  try {
    migrateSqlite(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
    });
    await seedD1(database);
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run(raceWorkspaceId, "embedding-race", "Embedding race");
    client
      .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
      .run(raceCategoryId, raceWorkspaceId, "race", "Race");
    client
      .prepare(
        `insert into articles
          (id, workspace_id, category_id, slug, title, mdx, status)
         values (?, ?, ?, ?, ?, ?, 'published')`,
      )
      .run(
        raceArticleId,
        raceWorkspaceId,
        raceCategoryId,
        "article",
        "Race article",
        "Race evidence.",
      );
    await exerciseEvidenceRepository(createSqliteRepository(database), "SQLite");
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run("workspace_other", "other", "Other");
    assert.throws(
      () =>
        client
          .prepare(
            "insert into workspace_index_states (workspace_id, generation, active_embedding_generation_id) values (?, ?, ?)",
          )
          .run("workspace_other", 0, "embedding_generation_pilot"),
      /FOREIGN KEY/u,
    );
    client
      .prepare(
        "insert into saved_question_sets (id, workspace_id, name, version, source_content_hash, questions) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "question_set_other",
        "workspace_other",
        "Other",
        1,
        questionSourceHash,
        "[]",
      );
    assert.throws(
      () =>
        client
          .prepare(
            "insert into evaluation_runs (id, workspace_id, question_set_id, index_generation, embedding_generation_id, retrieval_mode) values (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "evaluation_run_cross_workspace",
            "workspace_other",
            "question_set_other",
            0,
            "embedding_generation_pilot",
            "lexical",
          ),
      /FOREIGN KEY/u,
    );
    client.prepare("delete from workspaces where id = ?").run("workspace_other");
    client.prepare("delete from workspaces where id = ?").run(demoIds.workspace);
    client.prepare("delete from workspaces where id = ?").run(raceWorkspaceId);
    assert.equal(
      (client.prepare("select count(*) as count from embedding_generations").get() as { count: number })
        .count,
      0,
    );
    assert.equal(
      (client.prepare("select count(*) as count from evaluation_runs").get() as { count: number })
        .count,
      0,
    );
    assert.deepEqual(client.pragma("foreign_key_check"), []);
  } finally {
    client.close();
  }
});
