// ABOUTME: Serializes durable public-write reservations for SQLite and Cloudflare D1.
// ABOUTME: Enforces handoff reservations and one-minute outcome caps atomically.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type * as schema from "@/db/schema/sqlite";
import type {
  PublicOutcomeWriteWindow,
  PublicWriteAdmissionStore,
  PublicWriteReservation,
  PublicWriteReservationResult,
} from "@/outcomes/admission";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};
type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;
type ResultRow = Readonly<{
  accepted: number;
  retryAfterAt: number | null;
}>;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function preparedStatements(database: D1BackedDatabase, statements: SQL[]) {
  return statements.map((statement) => {
    const query = database.run(statement).getQuery();
    return database.$client.prepare(query.sql).bind(...query.params);
  });
}

function d1Rows<T>(value: unknown): T[] {
  return value !== null &&
    typeof value === "object" &&
    "results" in value &&
    Array.isArray(value.results)
    ? (value.results as T[])
    : [];
}

function reservationStatements(reservation: PublicWriteReservation) {
  const createdAt = reservation.createdAt.getTime();
  const windowStartedAt = reservation.windowStartedAt.getTime();
  return [
    sql`
      insert into workspace_public_write_states (workspace_id, updated_at)
      values (${reservation.workspaceId}, ${createdAt})
      on conflict (workspace_id) do nothing
    `,
    sql`
      update workspace_public_write_states
      set updated_at = ${createdAt}
      where workspace_id = ${reservation.workspaceId}
    `,
    sql`
      delete from public_write_reservations
      where (id, workspace_id, kind) in (
        select id, workspace_id, kind
        from public_write_reservations
        where workspace_id = ${reservation.workspaceId}
          and expires_at <= ${createdAt}
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
        ${createdAt},
        ${reservation.expiresAt.getTime()}
      where (
        select count(*)
        from public_write_reservations
        where workspace_id = ${reservation.workspaceId}
          and kind = ${reservation.kind}
          and created_at >= ${windowStartedAt}
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
              select min(created_at) + 86400000
              from public_write_reservations
              where workspace_id = ${reservation.workspaceId}
                and kind = ${reservation.kind}
                and created_at >= ${windowStartedAt}
            ),
            ${reservation.expiresAt.getTime()}
          )
        end as "retryAfterAt"
    `,
  ];
}

function result(row: ResultRow | undefined): PublicWriteReservationResult {
  if (row?.accepted === 1) return Object.freeze({ accepted: true as const });
  if (row?.retryAfterAt !== null && row?.retryAfterAt !== undefined) {
    const retryAfterAt = new Date(row.retryAfterAt);
    if (Number.isFinite(retryAfterAt.getTime())) {
      return Object.freeze({ accepted: false as const, retryAfterAt });
    }
  }
  throw new Error("Public write reservation failed");
}

async function reserve(
  database: SqliteDatabase,
  reservation: PublicWriteReservation,
) {
  const statements = reservationStatements(reservation);
  if (isD1Database(database)) {
    const results = await database.$client.batch(
      preparedStatements(database, statements),
    );
    return result(d1Rows<ResultRow>(results.at(-1))[0]);
  }
  return database.transaction((transaction) => {
    for (const statement of statements.slice(0, -1)) transaction.run(statement);
    return result(transaction.get<ResultRow>(statements.at(-1)!));
  });
}

async function consumeOutcomeWindow(
  database: SqliteDatabase,
  window: PublicOutcomeWriteWindow,
) {
  const statement = sql`
    insert into public_outcome_write_windows (
      workspace_id, window_started_at, write_count
    )
    values (${window.workspaceId}, ${window.windowStartedAt.getTime()}, 1)
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
  `;
  return (
    (await database.get<{ writeCount: number } | undefined>(statement)) !==
    undefined
  );
}

export function createSqlitePublicWriteAdmissionStore(
  database: SqliteDatabase,
): PublicWriteAdmissionStore {
  const store: PublicWriteAdmissionStore = {
    consumeOutcomeWindow: (window) => consumeOutcomeWindow(database, window),
    reserve: (reservation) => reserve(database, reservation),
    async cleanup(workspaceId, expiredAt, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("Public write cleanup limits must be between 1 and 1,000");
      }
      const statement = sql`
        delete from public_write_reservations
        where (id, workspace_id, kind) in (
          select id, workspace_id, kind
          from public_write_reservations
          where workspace_id = ${workspaceId}
            and expires_at <= ${expiredAt.getTime()}
          order by expires_at, id
          limit ${limit}
        )
        returning id
      `;
      if (isD1Database(database)) {
        return d1Rows<{ id: string }>(
          await preparedStatements(database, [statement])[0]!.all(),
        ).length;
      }
      return database.all<{ id: string }>(statement).length;
    },
  };
  return Object.freeze(store);
}
