// ABOUTME: Persists Postgres and Neon support-handoff reservations before external delivery.
// ABOUTME: Uses an atomic insert to make each workspace idempotency key single-use.
import { sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema/postgres";
import type {
  HandoffStorageRecord,
  HandoffStorageStatus,
  HandoffStore,
} from "@/handoff/service";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

type ReservationRow = Readonly<{
  payloadHash: string;
  status: HandoffStorageStatus;
}>;

const reservationFields = sql`
  payload_hash as "payloadHash",
  status
`;

function resultRows(value: unknown): ReservationRow[] {
  if (
    value !== null &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray(value.rows)
  ) {
    return value.rows as ReservationRow[];
  }
  return [];
}

function validRow(value: ReservationRow | undefined): value is ReservationRow {
  return Boolean(
    value &&
      /^[a-f\d]{64}$/u.test(value.payloadHash) &&
      (value.status === "pending" ||
        value.status === "delivered" ||
        value.status === "failed"),
  );
}

async function reserve(
  database: PostgresDatabase,
  record: HandoffStorageRecord,
) {
  const inserted = resultRows(
    await database.execute(sql<ReservationRow>`
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
        ${JSON.stringify(record.contact)}::jsonb,
        ${JSON.stringify(record.context)}::jsonb,
        ${record.createdAt},
        null
      )
      on conflict (id, workspace_id) do nothing
      returning ${reservationFields}
    `),
  )[0];
  if (validRow(inserted)) return { state: "reserved" as const };

  const existing = resultRows(
    await database.execute(sql<ReservationRow>`
      select ${reservationFields}
      from support_handoffs
      where id = ${record.id} and workspace_id = ${record.workspaceId}
      limit 1
    `),
  )[0];
  if (!validRow(existing)) throw new Error("Support handoff reservation failed");
  return existing.payloadHash === record.payloadHash
    ? { state: "duplicate" as const, status: existing.status }
    : { state: "conflict" as const };
}

export function createPostgresSupportHandoffStore(
  database: PostgresDatabase,
): HandoffStore {
  return Object.freeze({
    async cleanup(workspaceId: string, createdBefore: Date, limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new RangeError("Support handoff cleanup limits must be between 1 and 1,000");
      }
      return resultRows(
        await database.execute(sql<ReservationRow>`
          delete from support_handoffs
          where (id, workspace_id) in (
            select id, workspace_id
            from support_handoffs
            where workspace_id = ${workspaceId}
              and created_at < ${createdBefore}
            order by created_at, id
            limit ${limit}
          )
          returning ${reservationFields}
        `),
      ).length;
    },
    reserve: (record: HandoffStorageRecord) => reserve(database, record),
    async finish(request: Parameters<HandoffStore["finish"]>[0]) {
      await database.execute(sql`
        update support_handoffs
        set status = ${request.status}, finished_at = ${request.finishedAt}
        where id = ${request.id}
          and workspace_id = ${request.workspaceId}
          and status = 'pending'
      `);
    },
  });
}
