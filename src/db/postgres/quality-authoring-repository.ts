// ABOUTME: Persists saved quality fixtures and evaluations for authorized Postgres team members.
// ABOUTME: Rechecks the authoring fence and exact quality capability in every write transaction.
import { sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

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
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

async function executeAtomically(
  database: PostgresDatabase,
  statements: readonly SQL[],
) {
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    await database.batch(queries as [Query, ...Query[]]);
    return;
  }
  await database.transaction(async (transaction) => {
    for (const statement of statements) {
      await transaction.execute(statement);
    }
  });
}

function actorAssertion(
  workspaceId: string,
  request: QualityAuthoringRequest,
) {
  return sql`
    select 1 / count(*)::integer
    from (
      select member.id
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
        and session.expires_at > ${request.checkedAt}
        and ${request.workspaceId} = ${workspaceId}
      for share of member, session
    ) authorized_actor
  `;
}

function runningRunAssertion(workspaceId: string, id: string) {
  return sql`
    select 1 / count(*)::integer
    from (
      select id from evaluation_runs
      where workspace_id = ${workspaceId}
        and id = ${id}
        and status = 'running'
      for update
    ) current_run
  `;
}

function completedRunAssertion(workspaceId: string, id: string) {
  return sql`
    select 1 / count(*)::integer
    from (
      select id from evaluation_runs
      where workspace_id = ${workspaceId}
        and id = ${id}
        and status = 'completed'
      for update
    ) current_run
  `;
}

export function createPostgresQualityAuthoringRepository(
  database: PostgresDatabase,
): QualityAuthoringRepository {
  return {
    async finishAuthorizedEvaluationRun(request, completion) {
      validateEvaluationRunCompletion(completion);
      await executeAtomically(database, [
        authoringAssertion(completion.workspaceId, "postgres"),
        actorAssertion(completion.workspaceId, request),
        runningRunAssertion(completion.workspaceId, completion.id),
        sql`
          update evaluation_runs
          set status = ${completion.status},
              results = ${completion.results},
              completed_at = ${completion.completedAt}
          where workspace_id = ${completion.workspaceId}
            and id = ${completion.id}
            and status = 'running'
        `,
      ]);
    },

    async saveAuthorizedQuestionSet(request, questionSet) {
      validateQuestionSet(questionSet);
      await executeAtomically(database, [
        authoringAssertion(questionSet.workspaceId, "postgres"),
        actorAssertion(questionSet.workspaceId, request),
        sql`
          insert into saved_question_sets (
            id, workspace_id, name, version, source_content_hash, questions,
            created_at
          ) values (
            ${questionSet.id}, ${questionSet.workspaceId}, ${questionSet.name},
            ${questionSet.version}, ${questionSet.sourceContentHash},
            ${JSON.stringify(questionSet.questions)}::jsonb, ${questionSet.createdAt}
          )
        `,
      ]);
    },

    async startAuthorizedEvaluationRun(request, run) {
      validateEvaluationRunStart(run);
      await executeAtomically(database, [
        authoringAssertion(run.workspaceId, "postgres"),
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
            ${run.startedAt}, null
          )
        `,
      ]);
    },

    async updateAuthorizedEvaluationRunResults(request, update) {
      validateEvaluationRunResultsUpdate(update);
      await executeAtomically(database, [
        authoringAssertion(update.workspaceId, "postgres"),
        actorAssertion(update.workspaceId, request),
        completedRunAssertion(update.workspaceId, update.id),
        sql`
          update evaluation_runs set results = ${update.results}
          where workspace_id = ${update.workspaceId}
            and id = ${update.id}
            and status = 'completed'
        `,
      ]);
    },
  };
}
