// ABOUTME: Stores Postgres answer-inference leases behind a workspace serialization row.
// ABOUTME: Makes concurrency, spend reservation, expiry, and reconciliation one atomic contract.
import { sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type {
  AnswerInferenceLease,
  AnswerInferenceRepository,
  AnswerInferenceReservation,
  AnswerInferenceReconciliation,
} from "@/db/repository";
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

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
  startedAt: Date | string;
  expiresAt: Date | string;
  reconciledAt: Date | string | null;
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

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

function resultRows(value: unknown): LeaseRow[] {
  if (
    value !== null &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray(value.rows)
  ) {
    return value.rows as LeaseRow[];
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
  return [
    sql`
      insert into workspace_inference_states (workspace_id, updated_at)
      values (${reservation.workspaceId}, ${reservation.startedAt})
      on conflict (workspace_id) do nothing
    `,
    sql`
      update workspace_inference_states
      set updated_at = ${reservation.startedAt}
      where workspace_id = ${reservation.workspaceId}
    `,
    sql`
      update answer_inference_leases
      set status = 'expired',
          charged_microdollars = reserved_microdollars,
          input_tokens = null,
          output_tokens = null,
          reconciled_at = ${reservation.startedAt}
      where workspace_id = ${reservation.workspaceId}
        and status = 'active'
        and expires_at <= ${reservation.startedAt}
    `,
    sql`
      delete from answer_inference_leases
      where id in (
        select id
        from answer_inference_leases
        where workspace_id = ${reservation.workspaceId}
          and status <> 'active'
          and reconciled_at < ${reservation.retentionStartedAt}
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
        ${reservation.startedAt},
        ${reservation.expiresAt}
      where (
        select count(*)
        from answer_inference_leases
        where workspace_id = ${reservation.workspaceId}
          and status = 'active'
          and expires_at > ${reservation.startedAt}
      ) < ${reservation.maximumConcurrency}
        and (
          select coalesce(
            sum(coalesce(charged_microdollars, reserved_microdollars)),
            0
          )
          from answer_inference_leases
          where workspace_id = ${reservation.workspaceId}
            and started_at >= ${reservation.spendWindowStartedAt}
        ) + ${reservation.reservedMicrodollars}
          <= ${reservation.dailyBudgetMicrodollars}
      returning ${leaseFields}
    `,
  ];
}

async function reserve(
  database: PostgresDatabase,
  reservation: AnswerInferenceReservation,
) {
  const statements = reservationStatements(reservation);
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    const results = await database.batch(queries as [Query, ...Query[]]);
    const row = resultRows(results.at(-1))[0];
    return row ? lease(row) : null;
  }

  return database.transaction(async (transaction) => {
    let row: LeaseRow | undefined;
    for (const statement of statements) {
      row = resultRows(await transaction.execute(statement))[0] ?? row;
    }
    return row ? lease(row) : null;
  });
}

function reconciliationStatements(
  reconciliation: AnswerInferenceReconciliation,
) {
  return [
    sql<LeaseRow>`
      update answer_inference_leases
      set status = case
            when expires_at <= ${reconciliation.reconciledAt} then 'expired'
            else ${reconciliation.status}
          end,
          charged_microdollars = case
            when expires_at <= ${reconciliation.reconciledAt}
              then reserved_microdollars
            else ${reconciliation.chargedMicrodollars}
          end,
          input_tokens = case
            when expires_at <= ${reconciliation.reconciledAt}
              then null
            else ${reconciliation.inputTokens}::integer
          end,
          output_tokens = case
            when expires_at <= ${reconciliation.reconciledAt}
              then null
            else ${reconciliation.outputTokens}::integer
          end,
          reconciled_at = ${reconciliation.reconciledAt}
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
  database: PostgresDatabase,
  reconciliation: AnswerInferenceReconciliation,
) {
  const statements = reconciliationStatements(reconciliation);
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    const results = await database.batch(queries as [Query, ...Query[]]);
    const row = resultRows(results.at(-1))[0];
    return row ? lease(row) : null;
  }

  return database.transaction(async (transaction) => {
    await transaction.execute(statements[0]);
    const row = resultRows(await transaction.execute(statements[1]))[0];
    return row ? lease(row) : null;
  });
}

export function createPostgresAnswerInferenceRepository(
  database: PostgresDatabase,
): AnswerInferenceRepository {
  return {
    async reserveAnswerInference(reservation) {
      return reserve(database, reservation);
    },
    async reconcileAnswerInference(reconciliation) {
      return reconcile(database, reconciliation);
    },
    async getAnswerInferenceLease(workspaceId, id) {
      const result = await database.execute(sql<LeaseRow>`
        select ${leaseFields}
        from answer_inference_leases
        where id = ${id} and workspace_id = ${workspaceId}
        limit 1
      `);
      const row = resultRows(result)[0];
      return row ? lease(row) : null;
    },
  };
}
