// ABOUTME: Stores SQLite and D1 answer-inference leases in one atomic statement batch.
// ABOUTME: Serializes each workspace before enforcing concurrency and rolling spend limits.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type {
  AnswerInferenceLease,
  AnswerInferenceRepository,
  AnswerInferenceReservation,
  AnswerInferenceReconciliation,
} from "@/db/repository";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

type LeaseRow = {
  id: string;
  workspaceId: string;
  provider: string;
  model: string;
  maximumOutputTokens: number;
  reservedMicrodollars: number;
  chargedMicrodollars: number | null;
  status: AnswerInferenceLease["status"];
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: number;
  expiresAt: number;
  reconciledAt: number | null;
};

const leaseFields = sql`
  id,
  workspace_id as "workspaceId",
  provider,
  model,
  maximum_output_tokens as "maximumOutputTokens",
  reserved_microdollars as "reservedMicrodollars",
  charged_microdollars as "chargedMicrodollars",
  status,
  input_tokens as "inputTokens",
  output_tokens as "outputTokens",
  started_at as "startedAt",
  expires_at as "expiresAt",
  reconciled_at as "reconciledAt"
`;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function d1ResultRows(value: unknown): LeaseRow[] {
  if (
    value !== null &&
    typeof value === "object" &&
    "results" in value &&
    Array.isArray(value.results)
  ) {
    return value.results as LeaseRow[];
  }
  return [];
}

function lease(row: LeaseRow): AnswerInferenceLease {
  return {
    ...row,
    startedAt: new Date(row.startedAt),
    expiresAt: new Date(row.expiresAt),
    reconciledAt: row.reconciledAt === null ? null : new Date(row.reconciledAt),
  };
}

function reservationStatements(reservation: AnswerInferenceReservation) {
  const startedAt = reservation.startedAt.getTime();
  return [
    sql`
      insert into workspace_inference_states (workspace_id, updated_at)
      values (${reservation.workspaceId}, ${startedAt})
      on conflict (workspace_id) do nothing
    `,
    sql`
      update workspace_inference_states
      set updated_at = ${startedAt}
      where workspace_id = ${reservation.workspaceId}
    `,
    sql`
      update answer_inference_leases
      set status = 'expired',
          charged_microdollars = reserved_microdollars,
          input_tokens = null,
          output_tokens = null,
          reconciled_at = ${startedAt}
      where workspace_id = ${reservation.workspaceId}
        and status = 'active'
        and expires_at <= ${startedAt}
    `,
    sql`
      delete from answer_inference_leases
      where id in (
        select id
        from answer_inference_leases
        where workspace_id = ${reservation.workspaceId}
          and status <> 'active'
          and reconciled_at < ${reservation.retentionStartedAt.getTime()}
        order by reconciled_at, id
        limit 100
      )
    `,
    sql<LeaseRow>`
      insert into answer_inference_leases (
        id,
        workspace_id,
        provider,
        model,
        maximum_output_tokens,
        reserved_microdollars,
        status,
        started_at,
        expires_at
      )
      select
        ${reservation.id},
        ${reservation.workspaceId},
        ${reservation.provider},
        ${reservation.model},
        ${reservation.maximumOutputTokens},
        ${reservation.reservedMicrodollars},
        'active',
        ${startedAt},
        ${reservation.expiresAt.getTime()}
      where (
        select count(*)
        from answer_inference_leases
        where workspace_id = ${reservation.workspaceId}
          and status = 'active'
          and expires_at > ${startedAt}
      ) < ${reservation.maximumConcurrency}
        and (
          select coalesce(
            sum(coalesce(charged_microdollars, reserved_microdollars)),
            0
          )
          from answer_inference_leases
          where workspace_id = ${reservation.workspaceId}
            and started_at >= ${reservation.spendWindowStartedAt.getTime()}
        ) + ${reservation.reservedMicrodollars}
          <= ${reservation.dailyBudgetMicrodollars}
      returning ${leaseFields}
    `,
  ];
}

function preparedStatements(database: D1BackedDatabase, statements: SQL[]) {
  return statements.map((statement) => {
    const query = database.run(statement).getQuery();
    return database.$client.prepare(query.sql).bind(...query.params);
  });
}

async function reserve(
  database: SqliteDatabase,
  reservation: AnswerInferenceReservation,
) {
  const statements = reservationStatements(reservation);
  if (isD1Database(database)) {
    const results = await database.$client.batch(
      preparedStatements(database, statements),
    );
    const row = d1ResultRows(results.at(-1))[0];
    return row ? lease(row) : null;
  }

  return database.transaction((transaction) => {
    for (const statement of statements.slice(0, -1)) {
      transaction.run(statement);
    }
    const row = transaction.get<LeaseRow>(statements.at(-1)!);
    return row ? lease(row) : null;
  });
}

function reconciliationStatements(
  reconciliation: AnswerInferenceReconciliation,
) {
  const reconciledAt = reconciliation.reconciledAt.getTime();
  return [
    sql<LeaseRow>`
      update answer_inference_leases
      set status = case
            when expires_at <= ${reconciledAt} then 'expired'
            else ${reconciliation.status}
          end,
          charged_microdollars = case
            when expires_at <= ${reconciledAt}
              then reserved_microdollars
            else ${reconciliation.chargedMicrodollars}
          end,
          input_tokens = case
            when expires_at <= ${reconciledAt}
              then null
            else ${reconciliation.inputTokens}
          end,
          output_tokens = case
            when expires_at <= ${reconciledAt}
              then null
            else ${reconciliation.outputTokens}
          end,
          reconciled_at = ${reconciledAt}
      where id = ${reconciliation.id}
        and workspace_id = ${reconciliation.workspaceId}
        and status = 'active'
      returning ${leaseFields}
    `,
    sql<LeaseRow>`
      select ${leaseFields}
      from answer_inference_leases
      where id = ${reconciliation.id}
        and workspace_id = ${reconciliation.workspaceId}
      limit 1
    `,
  ];
}

async function reconcile(
  database: SqliteDatabase,
  reconciliation: AnswerInferenceReconciliation,
) {
  const statements = reconciliationStatements(reconciliation);
  if (isD1Database(database)) {
    const results = await database.$client.batch(
      preparedStatements(database, statements),
    );
    const row = d1ResultRows(results.at(-1))[0];
    return row ? lease(row) : null;
  }

  return database.transaction((transaction) => {
    transaction.run(statements[0]);
    const row = transaction.get<LeaseRow>(statements[1]);
    return row ? lease(row) : null;
  });
}

export function createSqliteAnswerInferenceRepository(
  database: SqliteDatabase,
): AnswerInferenceRepository {
  return {
    async reserveAnswerInference(reservation) {
      return reserve(database, reservation);
    },
    async reconcileAnswerInference(reconciliation) {
      return reconcile(database, reconciliation);
    },
    async getAnswerInferenceLease(workspaceId, id) {
      const row = await database.get<LeaseRow>(sql`
        select ${leaseFields}
        from answer_inference_leases
        where id = ${id} and workspace_id = ${workspaceId}
        limit 1
      `);
      return row ? lease(row) : null;
    },
  };
}
