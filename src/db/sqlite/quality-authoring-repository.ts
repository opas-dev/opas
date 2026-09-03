// ABOUTME: Persists saved quality fixtures and evaluations for authorized SQLite and D1 members.
// ABOUTME: Rechecks the authoring fence and exact quality capability in every write transaction.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import { authoringAssertion } from "@/db/authoring-controls";
import {
  validateEvaluationRunCompletion,
  validateEvaluationRunResultsUpdate,
  validateEvaluationRunStart,
  validateQuestionSet,
} from "@/db/evidence";
import type {
  QualityAuthoringRepository,
  QualityAuthoringRequest,
} from "@/db/repository";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase = D1BackedDatabase | BetterSQLite3Database<typeof schema>;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

async function executeAtomically(
  database: SqliteDatabase,
  statements: readonly SQL[],
) {
  if (isD1Database(database)) {
    const queries = statements.map((statement) => {
      const query = database.run(statement).getQuery();
      return database.$client.prepare(query.sql).bind(...query.params);
    });
    await database.$client.batch(queries);
    return;
  }
  database.transaction((transaction) => {
    for (const statement of statements) {
      transaction.run(statement);
    }
  });
}

function assertion(condition: SQL) {
  return sql`
    select json_extract('[]', case when ${condition} then '$[0]' else '$[' end)
  `;
}

function actorAssertion(
  workspaceId: string,
  request: QualityAuthoringRequest,
) {
  return assertion(sql`exists (
    select 1
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
     and session.member_id = member.id
    where member.workspace_id = ${workspaceId}
      and member.id = ${request.memberId}
      and member.status = 'active'
      and member.role in ('administrator', 'reviewer')
      and session.id = ${request.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${request.checkedAt.getTime()}
      and ${request.workspaceId} = ${workspaceId}
  )`);
}

function runAssertion(
  workspaceId: string,
  id: string,
  status: "completed" | "running",
) {
  return assertion(sql`exists (
    select 1 from evaluation_runs
    where workspace_id = ${workspaceId}
      and id = ${id}
      and status = ${status}
  )`);
}

export function createSqliteQualityAuthoringRepository(
  database: SqliteDatabase,
): QualityAuthoringRepository {
  return {
    async finishAuthorizedEvaluationRun(request, completion) {
      validateEvaluationRunCompletion(completion);
      await executeAtomically(database, [
        authoringAssertion(completion.workspaceId, "sqlite"),
        actorAssertion(completion.workspaceId, request),
        runAssertion(completion.workspaceId, completion.id, "running"),
        sql`
          update evaluation_runs
          set status = ${completion.status},
              results = ${JSON.stringify(completion.results)},
              completed_at = ${completion.completedAt.getTime()}
          where workspace_id = ${completion.workspaceId}
            and id = ${completion.id}
            and status = 'running'
        `,
      ]);
    },

    async saveAuthorizedQuestionSet(request, questionSet) {
      validateQuestionSet(questionSet);
      await executeAtomically(database, [
        authoringAssertion(questionSet.workspaceId, "sqlite"),
        actorAssertion(questionSet.workspaceId, request),
        sql`
          insert into saved_question_sets (
            id, workspace_id, name, version, source_content_hash, questions,
            created_at
          ) values (
            ${questionSet.id}, ${questionSet.workspaceId}, ${questionSet.name},
            ${questionSet.version}, ${questionSet.sourceContentHash},
            ${JSON.stringify(questionSet.questions)}, ${questionSet.createdAt.getTime()}
          )
        `,
      ]);
    },

    async startAuthorizedEvaluationRun(request, run) {
      validateEvaluationRunStart(run);
      await executeAtomically(database, [
        authoringAssertion(run.workspaceId, "sqlite"),
        actorAssertion(run.workspaceId, request),
        sql`
          insert into evaluation_runs (
            id, workspace_id, question_set_id, index_generation,
            embedding_generation_id, retrieval_mode, provider, model, status,
            results, started_at, completed_at
          ) values (
            ${run.id}, ${run.workspaceId}, ${run.questionSetId},
            ${run.indexGeneration}, ${run.embeddingGenerationId},
            ${run.retrievalMode}, ${run.provider}, ${run.model}, 'running', null,
            ${run.startedAt.getTime()}, null
          )
        `,
      ]);
    },

    async updateAuthorizedEvaluationRunResults(request, update) {
      validateEvaluationRunResultsUpdate(update);
      await executeAtomically(database, [
        authoringAssertion(update.workspaceId, "sqlite"),
        actorAssertion(update.workspaceId, request),
        runAssertion(update.workspaceId, update.id, "completed"),
        sql`
          update evaluation_runs set results = ${JSON.stringify(update.results)}
          where workspace_id = ${update.workspaceId}
            and id = ${update.id}
            and status = 'completed'
        `,
      ]);
    },
  };
}
