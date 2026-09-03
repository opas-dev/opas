// ABOUTME: Runs the saved-quality authoring contract against Postgres and local SQLite.
// ABOUTME: Proves exact roles, current sessions, workspace scope, and the authoring fence block writes.
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

import { AuthoringPausedError } from "@/db/authoring-controls";
import { createPostgresRepository } from "@/db/postgres/repository";
import type {
  EvaluationRunCompletion,
  EvaluationRunResultsUpdate,
  EvaluationRunStart,
  QualityAuthoringRequest,
  Repository,
  SavedQuestionSet,
} from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteRepository } from "@/db/sqlite/repository";

const workspaceId = "workspace_quality_authoring";
const otherWorkspaceId = "workspace_quality_other";
const memberId = "member_quality_reviewer";
const administratorId = "member_quality_administrator";
const sessionId = "Q".repeat(43);
const checkedAt = new Date("2026-09-03T12:00:00.000Z");
const expiresAt = new Date("2026-09-03T20:00:00.000Z");
const sourceHash = "a".repeat(64);
const baselineSetId = "question_set_quality_baseline";
const runningRunId = "evaluation_quality_running";
const completedRunId = "evaluation_quality_completed";

type Snapshot = Readonly<{
  completedResults: string;
  completedStatus: string;
  createdRuns: number;
  createdSets: number;
  runningStatus: string;
}>;

type QualityHarness = Readonly<{
  close: () => Promise<void>;
  repository: Repository;
  resetActor: () => Promise<void>;
  setMember: (
    status: "active" | "disabled",
    role: "administrator" | "editor" | "reviewer",
  ) => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  setRevoked: (revoked: boolean) => Promise<void>;
  snapshot: () => Promise<Snapshot>;
}>;

const initialResults = Object.freeze({ schema: "quality-test.initial" });
const finishedResults = Object.freeze({ schema: "quality-test.finished" });
const reviewedResults = Object.freeze({ schema: "quality-test.reviewed" });

function actor(requestWorkspaceId = workspaceId): QualityAuthoringRequest {
  return {
    checkedAt,
    memberId,
    sessionId,
    workspaceId: requestWorkspaceId,
  };
}

function questionSet(id: string): SavedQuestionSet {
  return {
    createdAt: checkedAt,
    id,
    name: `Quality set ${id}`,
    questions: [
      {
        acceptedSourceIds: [],
        classification: "unsupported",
        expectedOutcome: "abstain",
        id: `question_${id}`,
        question: "Is this unsupported?",
        sourceContentHashes: [],
      },
    ],
    sourceContentHash: sourceHash,
    version: 1,
    workspaceId,
  };
}

function run(id: string): EvaluationRunStart {
  return {
    embeddingGenerationId: null,
    id,
    indexGeneration: 0,
    model: "quality-test-model",
    provider: "quality-test-provider",
    questionSetId: baselineSetId,
    retrievalMode: "production-answer-runtime",
    startedAt: checkedAt,
    workspaceId,
  };
}

function completion(): EvaluationRunCompletion {
  return {
    completedAt: new Date(checkedAt.getTime() + 1_000),
    id: runningRunId,
    results: finishedResults,
    status: "completed",
    workspaceId,
  };
}

function reviewUpdate(): EvaluationRunResultsUpdate {
  return {
    id: completedRunId,
    results: reviewedResults,
    workspaceId,
  };
}

async function assertAllWritesRejected(
  harness: QualityHarness,
  label: string,
  request = actor(),
  paused = false,
) {
  const before = await harness.snapshot();
  const operations = [
    () =>
      harness.repository.saveAuthorizedQuestionSet(
        request,
        questionSet(`question_set_rejected_${label}`),
      ),
    () =>
      harness.repository.startAuthorizedEvaluationRun(
        request,
        run(`evaluation_rejected_${label}`),
      ),
    () => harness.repository.finishAuthorizedEvaluationRun(request, completion()),
    () =>
      harness.repository.updateAuthorizedEvaluationRunResults(
        request,
        reviewUpdate(),
      ),
  ];
  for (const operation of operations) {
    if (paused) {
      await assert.rejects(
        operation,
        (error: unknown) => error instanceof AuthoringPausedError,
        label,
      );
    } else {
      await assert.rejects(operation, label);
    }
  }
  assert.deepEqual(await harness.snapshot(), before, `${label} changed quality state`);
}

async function exercise(harness: QualityHarness) {
  try {
    await harness.setMember("active", "administrator");
    await harness.repository.saveAuthorizedQuestionSet(
      actor(),
      questionSet("question_set_quality_administrator_valid"),
    );
    await harness.resetActor();
    await harness.repository.saveAuthorizedQuestionSet(
      actor(),
      questionSet("question_set_quality_valid"),
    );
    await harness.repository.startAuthorizedEvaluationRun(
      actor(),
      run("evaluation_quality_valid"),
    );
    await harness.repository.finishAuthorizedEvaluationRun(actor(), completion());
    await harness.repository.updateAuthorizedEvaluationRunResults(
      actor(),
      reviewUpdate(),
    );
    assert.deepEqual(await harness.snapshot(), {
      completedResults: JSON.stringify(reviewedResults),
      completedStatus: "completed",
      createdRuns: 1,
      createdSets: 2,
      runningStatus: "completed",
    });

    await harness.resetActor();
    await harness.setMember("disabled", "reviewer");
    await assertAllWritesRejected(harness, "disabled");

    await harness.resetActor();
    await harness.setRevoked(true);
    await assertAllWritesRejected(harness, "revoked");

    await harness.resetActor();
    await harness.setMember("active", "editor");
    await assertAllWritesRejected(harness, "role_changed");

    await harness.resetActor();
    await assertAllWritesRejected(harness, "wrong_workspace", actor(otherWorkspaceId));

    await harness.resetActor();
    await harness.setPaused(true);
    await assertAllWritesRejected(harness, "paused", actor(), true);
  } finally {
    await harness.close();
  }
}

async function postgresHarness(): Promise<QualityHarness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  await migratePostgres(database, {
    migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
  });
  await pool.query(
    `insert into workspaces (id, slug, name) values
       ($1, 'quality-authoring', 'Quality authoring'),
       ($2, 'quality-other', 'Quality other')`,
    [workspaceId, otherWorkspaceId],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_at, updated_at
     ) values ($1, $2, 'administrator@quality.test', 'Quality administrator',
       'administrator', 'active', $3, $4, 600000, $5, $5)`,
    [administratorId, workspaceId, "A".repeat(43), "B".repeat(43), checkedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations,
       created_by_member_id, created_at, updated_at
     ) values ($1, $2, 'reviewer@quality.test', 'Quality reviewer', 'reviewer',
       'active', $3, $4, 600000, $5, $6, $6)`,
    [
      memberId,
      workspaceId,
      "C".repeat(43),
      "D".repeat(43),
      administratorId,
      checkedAt,
    ],
  );
  await pool.query(
    `insert into admin_sessions (
       id, workspace_id, member_id, created_at, expires_at
     ) values ($1, $2, $3, $4, $5)`,
    [sessionId, workspaceId, memberId, checkedAt, expiresAt],
  );
  await pool.query(
    `insert into saved_question_sets (
       id, workspace_id, name, version, source_content_hash, questions, created_at
     ) values ($1, $2, 'Baseline', 1, $3, $4::jsonb, $5)`,
    [baselineSetId, workspaceId, sourceHash, JSON.stringify(questionSet(baselineSetId).questions), checkedAt],
  );
  for (const [id, status, results] of [
    [runningRunId, "running", null],
    [completedRunId, "completed", initialResults],
  ] as const) {
    await pool.query(
      `insert into evaluation_runs (
         id, workspace_id, question_set_id, index_generation, retrieval_mode,
         status, results, started_at, completed_at
       ) values ($1, $2, $3, 0, 'production-answer-runtime', $4,
         $5::jsonb, $6::timestamptz,
         case when $4::text = 'completed' then $6::timestamptz else null end)`,
      [id, workspaceId, baselineSetId, status, results && JSON.stringify(results), checkedAt],
    );
  }
  return {
    async close() {
      await pool.end();
      await container.stop();
    },
    repository: createPostgresRepository(database),
    async resetActor() {
      await pool.query(
        "update workspace_members set status = 'active', role = 'reviewer' where id = $1",
        [memberId],
      );
      await pool.query("update admin_sessions set revoked_at = null where id = $1", [sessionId]);
      await pool.query(
        "update workspace_authoring_controls set writes_paused = false where workspace_id = $1",
        [workspaceId],
      );
    },
    async setMember(status, role) {
      await pool.query(
        "update workspace_members set status = $1, role = $2 where id = $3",
        [status, role, memberId],
      );
    },
    async setPaused(paused) {
      await pool.query(
        "update workspace_authoring_controls set writes_paused = $1 where workspace_id = $2",
        [paused, workspaceId],
      );
    },
    async setRevoked(revoked) {
      await pool.query("update admin_sessions set revoked_at = $1 where id = $2", [
        revoked ? checkedAt : null,
        sessionId,
      ]);
    },
    async snapshot() {
      const result = await pool.query<Snapshot>(
        `select
           (select count(*)::integer from saved_question_sets
             where id like 'question_set_%_valid') as "createdSets",
           (select count(*)::integer from evaluation_runs
             where id like 'evaluation_%_valid') as "createdRuns",
           (select status from evaluation_runs where id = $1) as "runningStatus",
           (select status from evaluation_runs where id = $2) as "completedStatus",
           (select results::text from evaluation_runs where id = $2) as "completedResults"`,
        [runningRunId, completedRunId],
      );
      const row = result.rows[0]!;
      return {
        ...row,
        completedResults: JSON.stringify(JSON.parse(row.completedResults)),
      };
    },
  };
}

async function sqliteHarness(): Promise<QualityHarness> {
  const client = new Database(":memory:");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, {
    migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
  });
  client
    .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
    .run(workspaceId, "quality-authoring", "Quality authoring");
  client
    .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
    .run(otherWorkspaceId, "quality-other", "Quality other");
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_at, updated_at
       ) values (?, ?, 'administrator@quality.test', 'Quality administrator',
         'administrator', 'active', ?, ?, 600000, ?, ?)`,
    )
    .run(
      administratorId,
      workspaceId,
      "A".repeat(43),
      "B".repeat(43),
      checkedAt.getTime(),
      checkedAt.getTime(),
    );
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values (?, ?, 'reviewer@quality.test', 'Quality reviewer', 'reviewer',
         'active', ?, ?, 600000, ?, ?, ?)`,
    )
    .run(
      memberId,
      workspaceId,
      "C".repeat(43),
      "D".repeat(43),
      administratorId,
      checkedAt.getTime(),
      checkedAt.getTime(),
    );
  client
    .prepare(
      `insert into admin_sessions (
         id, workspace_id, member_id, created_at, expires_at
       ) values (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, workspaceId, memberId, checkedAt.getTime(), expiresAt.getTime());
  client
    .prepare(
      `insert into saved_question_sets (
         id, workspace_id, name, version, source_content_hash, questions, created_at
       ) values (?, ?, 'Baseline', 1, ?, ?, ?)`,
    )
    .run(
      baselineSetId,
      workspaceId,
      sourceHash,
      JSON.stringify(questionSet(baselineSetId).questions),
      checkedAt.getTime(),
    );
  for (const [id, status, results] of [
    [runningRunId, "running", null],
    [completedRunId, "completed", initialResults],
  ] as const) {
    client
      .prepare(
        `insert into evaluation_runs (
           id, workspace_id, question_set_id, index_generation, retrieval_mode,
           status, results, started_at, completed_at
         ) values (?, ?, ?, 0, 'production-answer-runtime', ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        baselineSetId,
        status,
        results && JSON.stringify(results),
        checkedAt.getTime(),
        status === "completed" ? checkedAt.getTime() : null,
      );
  }
  return {
    async close() {
      client.close();
    },
    repository: createSqliteRepository(database),
    async resetActor() {
      client
        .prepare("update workspace_members set status = 'active', role = 'reviewer' where id = ?")
        .run(memberId);
      client.prepare("update admin_sessions set revoked_at = null where id = ?").run(sessionId);
      client
        .prepare("update workspace_authoring_controls set writes_paused = 0 where workspace_id = ?")
        .run(workspaceId);
    },
    async setMember(status, role) {
      client
        .prepare("update workspace_members set status = ?, role = ? where id = ?")
        .run(status, role, memberId);
    },
    async setPaused(paused) {
      client
        .prepare("update workspace_authoring_controls set writes_paused = ? where workspace_id = ?")
        .run(paused ? 1 : 0, workspaceId);
    },
    async setRevoked(revoked) {
      client
        .prepare("update admin_sessions set revoked_at = ? where id = ?")
        .run(revoked ? checkedAt.getTime() : null, sessionId);
    },
    async snapshot() {
      const row = client
        .prepare(
          `select
             (select count(*) from saved_question_sets
               where id like 'question_set_%_valid') as createdSets,
             (select count(*) from evaluation_runs
               where id like 'evaluation_%_valid') as createdRuns,
             (select status from evaluation_runs where id = ?) as runningStatus,
             (select status from evaluation_runs where id = ?) as completedStatus,
             (select results from evaluation_runs where id = ?) as completedResults`,
        )
        .get(runningRunId, completedRunId, completedRunId) as Snapshot;
      return {
        ...row,
        completedResults: JSON.stringify(JSON.parse(row.completedResults)),
      };
    },
  };
}

test(
  "Postgres saved-quality writes require a current quality actor and open fence",
  { timeout: 120_000 },
  async () => exercise(await postgresHarness()),
);

test("SQLite saved-quality writes require a current quality actor and open fence", async () =>
  exercise(await sqliteHarness()));
