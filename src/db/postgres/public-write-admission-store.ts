// ABOUTME: Serializes durable public-write reservations for Postgres and Neon workspaces.
// ABOUTME: Enforces handoff reservations and one-minute outcome caps atomically.
import { sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema/postgres";
import type {
  PublicOutcomeWriteWindow,
  PublicWriteAdmissionStore,
  PublicWriteReservation,
  PublicWriteReservationResult,
} from "@/outcomes/admission";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;
type ResultRow = Readonly<{
  accepted: boolean;
  retryAfterAt: Date | string | null;
}>;

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

function resultRows<T>(value: unknown): T[] {
  return value !== null &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray(value.rows)
    ? (value.rows as T[])
    : [];
}

function reservationStatements(reservation: PublicWriteReservation) {
  return [
    sql`
      insert into workspace_public_write_states (workspace_id, updated_at)
      values (${reservation.workspaceId}, ${reservation.createdAt})
      on conflict (workspace_id) do nothing
    `,
    sql`
      update workspace_public_write_states
      set updated_at = ${reservation.createdAt}
      where workspace_id = ${reservation.workspaceId}
    `,
    sql`
      delete from public_write_reservations
      where (id, workspace_id, kind) in (
        select id, workspace_id, kind
        from public_write_reservations
        where workspace_id = ${reservation.workspaceId}
          and expires_at <= ${reservation.createdAt}
        order by expires_at, id
        limit 100
      )
    `,
    sql`
      insert into public_write_reservations (
        id, workspace_id, kind, created_at, expires_at
      )
      select
        ${reservation.id},
        ${reservation.workspaceId},
        ${reservation.kind},
        ${reservation.createdAt},
        ${reservation.expiresAt}
      where (
        select count(*)
        from public_write_reservations
        where workspace_id = ${reservation.workspaceId}
          and kind = ${reservation.kind}
          and created_at >= ${reservation.windowStartedAt}
      ) < ${reservation.maximumWrites}
      on conflict do nothing
    `,
    sql<ResultRow>`
      select
        exists(
          select 1
          from public_write_reservations
          where id = ${reservation.id}
            and workspace_id = ${reservation.workspaceId}
            and kind = ${reservation.kind}
        ) as accepted,
        case
          when exists(
            select 1
            from public_write_reservations
            where id = ${reservation.id}
              and workspace_id = ${reservation.workspaceId}
              and kind = ${reservation.kind}
          ) then null
          else coalesce(
            (
              select min(created_at) + interval '24 hours'
              from public_write_reservations
              where workspace_id = ${reservation.workspaceId}
                and kind = ${reservation.kind}
                and created_at >= ${reservation.windowStartedAt}
            ),
            ${reservation.expiresAt}
          )
        end as "retryAfterAt"
    `,
  ];
}

function result(row: ResultRow | undefined): PublicWriteReservationResult {
  if (row?.accepted === true) return Object.freeze({ accepted: true as const });
  if (row?.retryAfterAt) {
    const retryAfterAt = new Date(row.retryAfterAt);
    if (Number.isFinite(retryAfterAt.getTime())) {
      return Object.freeze({ accepted: false as const, retryAfterAt });
    }
  }
  throw new Error("Public write reservation failed");
}

async function reserve(
  database: PostgresDatabase,
  reservation: PublicWriteReservation,
) {
  const statements = reservationStatements(reservation);
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    const results = await database.batch(queries as [Query, ...Query[]]);
    return result(resultRows<ResultRow>(results.at(-1))[0]);
  }
  return database.transaction(async (transaction) => {
    let row: ResultRow | undefined;
    for (const statement of statements) {
      row = resultRows<ResultRow>(await transaction.execute(statement))[0] ?? row;
    }
    return result(row);
  });
}

async function consumeOutcomeWindow(
  database: PostgresDatabase,
  window: PublicOutcomeWriteWindow,
) {
  const rows = resultRows<{ writeCount: number }>(
    await database.execute(sql`
      insert into public_outcome_write_windows (
        workspace_id, window_started_at, write_count
      )
      values (${window.workspaceId}, ${window.windowStartedAt}, 1)
      on conflict (workspace_id) do update
      set
        window_started_at = excluded.window_started_at,
        write_count = case
          when public_outcome_write_windows.window_started_at = excluded.window_started_at
          then public_outcome_write_windows.write_count + 1
          else 1
        end
      where
        public_outcome_write_windows.window_started_at < excluded.window_started_at
        or (
          public_outcome_write_windows.window_started_at = excluded.window_started_at
          and public_outcome_write_windows.write_count < ${window.maximumWrites}
        )
      returning write_count as "writeCount"
    `),
  );
  return rows.length === 1;
}

export function createPostgresPublicWriteAdmissionStore(
  database: PostgresDatabase,
): PublicWriteAdmissionStore {
  const store: PublicWriteAdmissionStore = {
    consumeOutcomeWindow: (window) => consumeOutcomeWindow(database, window),
    reserve: (reservation) => reserve(database, reservation),
    async cleanup(workspaceId, expiredAt, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("Public write cleanup limits must be between 1 and 1,000");
      }
      return resultRows<{ id: string }>(
        await database.execute(sql`
          delete from public_write_reservations
          where (id, workspace_id, kind) in (
            select id, workspace_id, kind
            from public_write_reservations
            where workspace_id = ${workspaceId}
              and expires_at <= ${expiredAt}
            order by expires_at, id
            limit ${limit}
          )
          returning id
        `),
      ).length;
    },
  };
  return Object.freeze(store);
}
