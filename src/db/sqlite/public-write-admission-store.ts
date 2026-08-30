// ABOUTME: Serializes durable public-write reservations for SQLite and Cloudflare D1.
// ABOUTME: Uses one atomic batch to enforce rolling handoff caps without requester data.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type * as schema from "@/db/schema/sqlite";
import type {
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

export function createSqlitePublicWriteAdmissionStore(
  database: SqliteDatabase,
): PublicWriteAdmissionStore {
  const store: PublicWriteAdmissionStore = {
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
