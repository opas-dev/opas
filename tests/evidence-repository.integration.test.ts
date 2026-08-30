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
    provider: "test-provider",
    model: "test-embedding-v1",
    dimension: 3,
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
      embeddingGenerationId: "embedding_generation_pilot",
      maximumAttempts: 3,
      availableAt: startedAt,
    },
  };
}

async function exerciseEvidenceRepository(repository: Repository, label: string) {
  assert.equal(await repository.getIndexingState(demoIds.workspace), null);
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

  const committedState = await repository.commitArticleEvidence(evidenceCommit());
  assert.equal(committedState.generation, 1, `${label} did not create generation one`);
  assert.equal(committedState.activeEmbeddingGenerationId, null);

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

  const firstLeaseExpiry = new Date(startedAt.getTime() + 30_000);
  const firstLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    claimedAt: startedAt,
    leaseExpiresAt: firstLeaseExpiry,
    leaseToken: "lease_initial",
  });
  assert.equal(firstLease?.id, "embedding_job_initial");
  assert.equal(firstLease?.status, "leased");
  assert.equal(firstLease?.attempts, 1);
  const repeatedLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    claimedAt: new Date(startedAt.getTime() + 500),
    leaseExpiresAt: new Date(firstLeaseExpiry.getTime() + 30_000),
    leaseToken: "lease_initial",
  });
  assert.equal(repeatedLease?.id, "embedding_job_initial");
  assert.equal(repeatedLease?.attempts, 1, `${label} claimed a second job for one lease token`);
  assert.equal(repeatedLease?.leaseExpiresAt?.getTime(), firstLeaseExpiry.getTime());
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_initial",
      completedChunkCount: 1,
      checkedAt: new Date(startedAt.getTime() + 1_000),
    }),
    true,
  );
  assert.equal(
    await repository.checkpointEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_initial",
      completedChunkCount: 0,
      checkedAt: new Date(startedAt.getTime() + 2_000),
    }),
    false,
    `${label} moved a job checkpoint backwards`,
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
      claimedAt: new Date(retryAt.getTime() - 1),
      leaseExpiresAt: new Date(retryAt.getTime() + 30_000),
      leaseToken: "lease_too_early",
    }),
    null,
  );

  const secondLease = await repository.claimEmbeddingJob({
    workspaceId: demoIds.workspace,
    claimedAt: retryAt,
    leaseExpiresAt: new Date(retryAt.getTime() + 30_000),
    leaseToken: "lease_retry",
  });
  assert.equal(secondLease?.attempts, 2);
  assert.equal(secondLease?.checkpoint, 1);

  await repository.saveChunkEmbeddings({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    embeddings: [
      {
        chunkId: "chunk_intro",
        contentHash: firstSourceHash,
        embeddingInputHash: firstEmbeddingInputHash,
        vector: [1, 0, 0],
      },
      {
        chunkId: "chunk_install",
        contentHash: secondSourceHash,
        embeddingInputHash: secondEmbeddingInputHash,
        vector: [0, 1, 0],
      },
    ],
    createdAt: retryAt,
  });
  assert.equal(
    await repository.completeEmbeddingJob({
      workspaceId: demoIds.workspace,
      id: "embedding_job_initial",
      leaseToken: "lease_retry",
      checkedAt: new Date(retryAt.getTime() + 1_000),
    }),
    true,
  );
  assert.equal(
    await repository.activateEmbeddingGeneration(
      demoIds.workspace,
      "embedding_generation_pilot",
      new Date(retryAt.getTime() + 2_000),
    ),
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
  const incompleteActivationAt = new Date(retryAt.getTime() + 2_500);
  assert.equal(
    await repository.activateEmbeddingGeneration(
      demoIds.workspace,
      "embedding_generation_pilot",
      incompleteActivationAt,
    ),
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
    [{ id: "chunk_intro", vector: [1, 0, 0] }],
    `${label} did not preserve only the unchanged embedding`,
  );

  const changedClaimedAt = new Date(retryAt.getTime() + 3_000);
  const changedLeaseExpiry = new Date(changedClaimedAt.getTime() + 1_000);
  assert.equal(
    (
      await repository.claimEmbeddingJob({
        workspaceId: demoIds.workspace,
        claimedAt: changedClaimedAt,
        leaseExpiresAt: changedLeaseExpiry,
        leaseToken: "lease_changed",
      })
    )?.attempts,
    1,
  );
  assert.equal(
    await repository.claimEmbeddingJob({
      workspaceId: demoIds.workspace,
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

  const pendingCommit: ArticleEvidenceCommit = {
    ...changedCommit,
    chunks: changedCommit.chunks.map((chunk) => ({ ...chunk })),
    job: {
      ...changedCommit.job,
      id: "embedding_job_pending",
      maximumAttempts: 3,
    },
  };
  const pendingState = await repository.commitArticleEvidence(pendingCommit);
  assert.equal(pendingState.generation, 3);

  const invalidatedState = await repository.invalidateArticleEvidence(
    demoIds.workspace,
    demoIds.publishedArticle,
    new Date(retryAt.getTime() + 3_000),
  );
  assert.equal(invalidatedState.generation, 4);
  assert.deepEqual(await repository.listEvidenceChunks(demoIds.workspace), []);
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_pending"))
      ?.status,
    "superseded",
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
    articleContentHash: "5".repeat(64),
    chunks: bulkChunks,
    job: {
      id: "embedding_job_bulk",
      embeddingGenerationId: "embedding_generation_pilot",
      maximumAttempts: 3,
      availableAt: startedAt,
    },
  });
  assert.equal(bulkState.generation, 5);
  await repository.saveChunkEmbeddings({
    workspaceId: demoIds.workspace,
    embeddingGenerationId: "embedding_generation_pilot",
    embeddings: bulkChunks.map((chunk, ordinal) => ({
      chunkId: chunk.id,
      contentHash: chunk.contentHash,
      embeddingInputHash: chunk.embeddingInputHash,
      vector: [ordinal, 0, 0],
    })),
    createdAt: new Date(retryAt.getTime() + 6_000),
  });
  assert.equal(
    await repository.activateEmbeddingGeneration(
      demoIds.workspace,
      "embedding_generation_pilot",
      new Date(retryAt.getTime() + 7_000),
    ),
    true,
  );
  assert.equal(
    (await repository.listActiveChunkEmbeddings(demoIds.workspace)).length,
    bulkChunks.length,
  );
  const bulkInvalidatedState = await repository.invalidateArticleEvidence(
    demoIds.workspace,
    demoIds.publishedArticle,
    new Date(retryAt.getTime() + 8_000),
  );
  assert.equal(bulkInvalidatedState.generation, 6);
  assert.equal(
    (await repository.getEmbeddingJob(demoIds.workspace, "embedding_job_bulk"))?.status,
    "superseded",
  );

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
    indexGeneration: 6,
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
