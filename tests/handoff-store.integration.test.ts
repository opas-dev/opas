// ABOUTME: Runs the support-handoff reservation contract against Postgres, SQLite, and D1 semantics.
// ABOUTME: Verifies atomic deduplication, collision handling, lifecycle updates, and separated storage.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createD1Database } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { createPostgresSupportHandoffStore } from "@/db/postgres/support-handoff-store";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteSupportHandoffStore } from "@/db/sqlite/support-handoff-store";
import type {
  HandoffStorageRecord,
  HandoffStore,
} from "@/handoff/service";

const workspaceId = "workspace_handoff";
const id = "123e4567-e89b-42d3-a456-426614174000";

function storageRecord(
  overrides: Partial<HandoffStorageRecord> = {},
): HandoffStorageRecord {
  return Object.freeze({
    contact: Object.freeze({ email: "reader@example.com", name: "Reader" }),
    context: Object.freeze({
      citations: Object.freeze([]),
      outcome: "abstained" as const,
      pageUrl: "https://customer.example.com/account",
      question: "How do I reset my password?",
      transcript: Object.freeze([
        Object.freeze({
          content: "How do I reset my password?",
          role: "user" as const,
        }),
      ]),
    }),
    createdAt: new Date("2026-08-30T12:00:00.000Z"),
    id,
    payloadHash: "a".repeat(64),
    status: "pending" as const,
    workspaceId,
    ...overrides,
  });
}

async function exerciseStore(
  name: string,
  store: HandoffStore,
  storedRow: () => Promise<Readonly<Record<string, unknown>>>,
) {
  const record = storageRecord();
  const reservations = await Promise.all(
    Array.from({ length: 12 }, () => store.reserve(record)),
  );

  assert.equal(
    reservations.filter(({ state }) => state === "reserved").length,
    1,
    `${name} sent more than one reservation winner`,
  );
  assert.equal(
    reservations.filter(
      (reservation) =>
        reservation.state === "duplicate" && reservation.status === "pending",
    ).length,
    11,
    `${name} did not deduplicate every concurrent loser`,
  );
  assert.deepEqual(
    await store.reserve(storageRecord({ payloadHash: "b".repeat(64) })),
    { state: "conflict" },
    `${name} accepted an idempotency collision`,
  );

  const finishedAt = new Date("2026-08-30T12:00:01.000Z");
  await store.finish({ finishedAt, id, status: "delivered", workspaceId });
  await store.finish({
    finishedAt: new Date("2026-08-30T12:00:02.000Z"),
    id,
    status: "failed",
    workspaceId,
  });
  assert.deepEqual(await store.reserve(record), {
    state: "duplicate",
    status: "delivered",
  });

  const row = await storedRow();
  assert.equal(row.status, "delivered");
  assert.equal(new Date(String(row.finishedAt)).toISOString(), finishedAt.toISOString());
  assert.deepEqual(
    typeof row.contact === "string" ? JSON.parse(row.contact) : row.contact,
    record.contact,
  );
  const context =
    typeof row.context === "string" ? JSON.parse(row.context) : row.context;
  assert.deepEqual(context, record.context);
  assert.equal("contact" in (context as Record<string, unknown>), false);
}

function createD1Facade(client: Database.Database) {
  const d1 = {
    prepare(source: string) {
      return {
        bind(...parameters: unknown[]) {
          return {
            async first<T>() {
              return (client.prepare(source).get(...parameters) as T | undefined) ?? null;
            },
            async run() {
              const result = client.prepare(source).run(...parameters);
              return {
                meta: { changes: result.changes },
                results: [],
                success: true,
              };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as AnyD1Database;
  return createD1Database(d1, { schema: sqliteSchema });
}

function migratedSqlite() {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, {
    migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
  });
  client
    .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
    .run(workspaceId, "handoff", "Handoff");
  return { client, database };
}

test("support handoff store passes on local SQLite", async () => {
  const { client, database } = migratedSqlite();
  try {
    await exerciseStore(
      "SQLite",
      createSqliteSupportHandoffStore(database),
      async () =>
        client
          .prepare(
            `select status, contact, context,
                    datetime(finished_at / 1000, 'unixepoch') || '.000Z' as finishedAt
             from support_handoffs where id = ? and workspace_id = ?`,
          )
          .get(id, workspaceId) as Record<string, unknown>,
    );
  } finally {
    client.close();
  }
});

test("support handoff store passes through the D1 client path", async () => {
  const { client } = migratedSqlite();
  try {
    await exerciseStore(
      "D1",
      createSqliteSupportHandoffStore(createD1Facade(client)),
      async () =>
        client
          .prepare(
            `select status, contact, context,
                    datetime(finished_at / 1000, 'unixepoch') || '.000Z' as finishedAt
             from support_handoffs where id = ? and workspace_id = ?`,
          )
          .get(id, workspaceId) as Record<string, unknown>,
    );
  } finally {
    client.close();
  }
});

test(
  "support handoff store passes on Postgres",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const database = createPostgresDatabase(pool, { schema: postgresSchema });
    try {
      await migratePostgres(database, {
        migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
      });
      await pool.query(
        "insert into workspaces (id, slug, name) values ($1, $2, $3)",
        [workspaceId, "handoff", "Handoff"],
      );
      await exerciseStore(
        "Postgres",
        createPostgresSupportHandoffStore(database),
        async () => {
          const result = await pool.query<Record<string, unknown>>(
            `select status, contact, context, finished_at as "finishedAt"
             from support_handoffs where id = $1 and workspace_id = $2`,
            [id, workspaceId],
          );
          return result.rows[0]!;
        },
      );
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);
