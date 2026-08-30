// ABOUTME: Persists SQLite and D1 support-handoff reservations before external delivery.
// ABOUTME: Uses one atomic insert while keeping contact and conversation context separate.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type * as schema from "@/db/schema/sqlite";
import type {
  HandoffStorageRecord,
  HandoffStorageStatus,
  HandoffStore,
} from "@/handoff/service";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

type ReservationRow = Readonly<{
  payloadHash: string;
  status: HandoffStorageStatus;
}>;

const reservationFields = sql`
  payload_hash as "payloadHash",
  status
`;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function validRow(value: ReservationRow | null | undefined): value is ReservationRow {
  return Boolean(
    value &&
      /^[a-f\d]{64}$/u.test(value.payloadHash) &&
      (value.status === "pending" ||
        value.status === "delivered" ||
        value.status === "failed"),
  );
}

function d1Statement(database: D1BackedDatabase, statement: SQL) {
  const query = database.run(statement).getQuery();
  return database.$client.prepare(query.sql).bind(...query.params);
}

function d1Rows(value: unknown) {
  return value !== null &&
    typeof value === "object" &&
    "results" in value &&
    Array.isArray(value.results)
    ? value.results
    : [];
}

async function row(database: SqliteDatabase, statement: SQL) {
  return isD1Database(database)
    ? d1Statement(database, statement).first<ReservationRow>()
    : database.get<ReservationRow>(statement);
}

async function run(database: SqliteDatabase, statement: SQL) {
  if (isD1Database(database)) {
    await d1Statement(database, statement).run();
    return;
  }
  database.run(statement);
}

async function reserve(database: SqliteDatabase, record: HandoffStorageRecord) {
  const inserted = await row(
    database,
    sql`
      insert into support_handoffs (
        id,
        workspace_id,
        payload_hash,
        status,
        contact,
        context,
        created_at,
        finished_at
      )
      values (
        ${record.id},
        ${record.workspaceId},
        ${record.payloadHash},
        'pending',
        ${JSON.stringify(record.contact)},
        ${JSON.stringify(record.context)},
        ${record.createdAt.getTime()},
        null
      )
      on conflict (id, workspace_id) do nothing
      returning ${reservationFields}
    `,
  );
  if (validRow(inserted)) return { state: "reserved" as const };

  const existing = await row(
    database,
    sql`
      select ${reservationFields}
      from support_handoffs
      where id = ${record.id} and workspace_id = ${record.workspaceId}
      limit 1
    `,
  );
  if (!validRow(existing)) throw new Error("Support handoff reservation failed");
  return existing.payloadHash === record.payloadHash
    ? { state: "duplicate" as const, status: existing.status }
    : { state: "conflict" as const };
}

export function createSqliteSupportHandoffStore(
  database: SqliteDatabase,
): HandoffStore {
  return Object.freeze({
    async cleanup(workspaceId: string, createdBefore: Date, limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("Support handoff cleanup limits must be between 1 and 1,000");
      }
      const statement = sql`
        delete from support_handoffs
        where (id, workspace_id) in (
          select id, workspace_id
          from support_handoffs
          where workspace_id = ${workspaceId}
            and created_at < ${createdBefore.getTime()}
          order by created_at, id
          limit ${limit}
        )
        returning id
      `;
      return isD1Database(database)
        ? d1Rows(await d1Statement(database, statement).all()).length
        : database.all<{ id: string }>(statement).length;
    },
    reserve: (record: HandoffStorageRecord) => reserve(database, record),
    async finish(request: Parameters<HandoffStore["finish"]>[0]) {
      await run(
        database,
        sql`
          update support_handoffs
          set status = ${request.status}, finished_at = ${request.finishedAt.getTime()}
          where id = ${request.id}
            and workspace_id = ${request.workspaceId}
            and status = 'pending'
        `,
      );
    },
  });
}
