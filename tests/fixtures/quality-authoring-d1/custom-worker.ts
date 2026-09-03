// ABOUTME: Exercises authorized saved-quality mutations through a native D1 repository binding.
// ABOUTME: Reports exact role, session, workspace, and authoring-fence no-write outcomes.
import { drizzle } from "drizzle-orm/d1";

import type { QualityAuthoringRequest, SavedQuestionSet } from "../../../src/db/repository";
import * as schema from "../../../src/db/schema/sqlite";
import { createSqliteRepository } from "../../../src/db/sqlite/repository";

type Environment = Readonly<{ DB: D1Database }>;

const workspaceId = "workspace_quality_d1";
const otherWorkspaceId = "workspace_quality_d1_other";
const administratorId = "member_quality_d1_administrator";
const memberId = "member_quality_d1_reviewer";
const sessionId = "Q".repeat(43);
const timestamp = Date.parse("2026-09-03T12:00:00.000Z");
const sourceHash = "a".repeat(64);
const baselineSetId = "question_set_quality_d1_baseline";
const runningRunId = "evaluation_quality_d1_running";
const completedRunId = "evaluation_quality_d1_completed";
const initialResults = Object.freeze({ schema: "quality-test.initial" });

function actor(requestWorkspaceId = workspaceId): QualityAuthoringRequest {
  return {
    checkedAt: new Date(timestamp),
    memberId,
    sessionId,
    workspaceId: requestWorkspaceId,
  };
}

function questionSet(id: string): SavedQuestionSet {
  return {
    createdAt: new Date(timestamp),
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

async function setup(environment: Environment) {
  await environment.DB.batch([
    environment.DB
      .prepare("insert into workspaces (id, slug, name) values (?, 'quality-d1', 'Quality D1')")
      .bind(workspaceId),
    environment.DB
      .prepare("insert into workspaces (id, slug, name) values (?, 'quality-d1-other', 'Quality D1 other')")
      .bind(otherWorkspaceId),
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'administrator@quality.test', 'Quality administrator',
           'administrator', 'active', ?, ?, 600000, ?, ?)`,
      )
      .bind(administratorId, workspaceId, "A".repeat(43), "B".repeat(43), timestamp, timestamp),
  ]);
  await environment.DB.batch([
    environment.DB
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'reviewer@quality.test', 'Quality reviewer', 'reviewer',
           'active', ?, ?, 600000, ?, ?, ?)`,
      )
      .bind(
        memberId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        administratorId,
        timestamp,
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, workspaceId, memberId, timestamp, timestamp + 28_800_000),
    environment.DB
      .prepare(
        `insert into saved_question_sets (
           id, workspace_id, name, version, source_content_hash, questions, created_at
         ) values (?, ?, 'Baseline', 1, ?, ?, ?)`,
      )
      .bind(
        baselineSetId,
        workspaceId,
        sourceHash,
        JSON.stringify(questionSet(baselineSetId).questions),
        timestamp,
      ),
    environment.DB
      .prepare(
        `insert into evaluation_runs (
           id, workspace_id, question_set_id, index_generation, retrieval_mode,
           status, results, started_at
         ) values (?, ?, ?, 0, 'production-answer-runtime', 'running', null, ?)`,
      )
      .bind(runningRunId, workspaceId, baselineSetId, timestamp),
    environment.DB
      .prepare(
        `insert into evaluation_runs (
           id, workspace_id, question_set_id, index_generation, retrieval_mode,
           status, results, started_at, completed_at
         ) values (?, ?, ?, 0, 'production-answer-runtime', 'completed', ?, ?, ?)`,
      )
      .bind(
        completedRunId,
        workspaceId,
        baselineSetId,
        JSON.stringify(initialResults),
        timestamp,
        timestamp,
      ),
  ]);
}

async function snapshot(environment: Environment) {
  const row = await environment.DB.prepare(
    `select
       (select count(*) from saved_question_sets where id like 'question_set_%_valid') as sets,
       (select count(*) from evaluation_runs where id like 'evaluation_%_valid') as runs,
       (select status from evaluation_runs where id = ?) as running_status,
       (select results from evaluation_runs where id = ?) as completed_results`,
  )
    .bind(runningRunId, completedRunId)
    .first<Record<string, unknown>>();
  return JSON.stringify(row);
}

async function rejected(
  environment: Environment,
  label: string,
  request = actor(),
) {
  const repository = createSqliteRepository(drizzle(environment.DB, { schema }));
  const before = await snapshot(environment);
  const operations = [
    () =>
      repository.saveAuthorizedQuestionSet(
        request,
        questionSet(`question_set_rejected_${label}`),
      ),
    () =>
      repository.startAuthorizedEvaluationRun(request, {
        embeddingGenerationId: null,
        id: `evaluation_rejected_${label}`,
        indexGeneration: 0,
        model: "quality-test-model",
        provider: "quality-test-provider",
        questionSetId: baselineSetId,
        retrievalMode: "production-answer-runtime",
        startedAt: new Date(timestamp),
        workspaceId,
      }),
    () =>
      repository.finishAuthorizedEvaluationRun(request, {
        completedAt: new Date(timestamp + 1_000),
        id: runningRunId,
        results: { schema: "quality-test.finished" },
        status: "completed",
        workspaceId,
      }),
    () =>
      repository.updateAuthorizedEvaluationRunResults(request, {
        id: completedRunId,
        results: { schema: "quality-test.reviewed" },
        workspaceId,
      }),
  ];
  let failures = 0;
  for (const operation of operations) {
    try {
      await operation();
    } catch {
      failures += 1;
    }
  }
  return failures === operations.length && (await snapshot(environment)) === before;
}

async function resetActor(environment: Environment) {
  await environment.DB.batch([
    environment.DB
      .prepare("update workspace_members set status = 'active', role = 'reviewer' where id = ?")
      .bind(memberId),
    environment.DB
      .prepare("update admin_sessions set revoked_at = null where id = ?")
      .bind(sessionId),
    environment.DB
      .prepare("update workspace_authoring_controls set writes_paused = 0 where workspace_id = ?")
      .bind(workspaceId),
  ]);
}

async function exercise(environment: Environment) {
  await setup(environment);
  const repository = createSqliteRepository(drizzle(environment.DB, { schema }));
  await environment.DB.prepare("update workspace_members set role = 'administrator' where id = ?")
    .bind(memberId)
    .run();
  await repository.saveAuthorizedQuestionSet(
    actor(),
    questionSet("question_set_quality_d1_administrator_valid"),
  );
  await resetActor(environment);
  await repository.saveAuthorizedQuestionSet(actor(), questionSet("question_set_quality_d1_valid"));
  await repository.startAuthorizedEvaluationRun(actor(), {
    embeddingGenerationId: null,
    id: "evaluation_quality_d1_valid",
    indexGeneration: 0,
    model: "quality-test-model",
    provider: "quality-test-provider",
    questionSetId: baselineSetId,
    retrievalMode: "production-answer-runtime",
    startedAt: new Date(timestamp),
    workspaceId,
  });
  await repository.finishAuthorizedEvaluationRun(actor(), {
    completedAt: new Date(timestamp + 1_000),
    id: runningRunId,
    results: { schema: "quality-test.finished" },
    status: "completed",
    workspaceId,
  });
  await repository.updateAuthorizedEvaluationRunResults(actor(), {
    id: completedRunId,
    results: { schema: "quality-test.reviewed" },
    workspaceId,
  });
  const valid = (await snapshot(environment)).includes('"sets":2');

  await resetActor(environment);
  await environment.DB.prepare("update workspace_members set status = 'disabled' where id = ?")
    .bind(memberId)
    .run();
  const disabled = await rejected(environment, "disabled");

  await resetActor(environment);
  await environment.DB.prepare("update admin_sessions set revoked_at = ? where id = ?")
    .bind(timestamp, sessionId)
    .run();
  const revoked = await rejected(environment, "revoked");

  await resetActor(environment);
  await environment.DB.prepare("update workspace_members set role = 'editor' where id = ?")
    .bind(memberId)
    .run();
  const roleChanged = await rejected(environment, "role_changed");

  await resetActor(environment);
  const wrongWorkspace = await rejected(environment, "wrong_workspace", actor(otherWorkspaceId));

  await resetActor(environment);
  await environment.DB.prepare(
    "update workspace_authoring_controls set writes_paused = 1 where workspace_id = ?",
  )
    .bind(workspaceId)
    .run();
  const paused = await rejected(environment, "paused");

  return { disabled, paused, revoked, roleChanged, valid, wrongWorkspace };
}

const qualityAuthoringWorker = {
  async fetch(request: Request, environment: Environment) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path !== "/exercise" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    try {
      return Response.json(await exercise(environment));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown" },
        { status: 500 },
      );
    }
  },
};

export default qualityAuthoringWorker;
