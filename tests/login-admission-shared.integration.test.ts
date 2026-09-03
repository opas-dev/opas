// ABOUTME: Verifies login admission limits are shared by independent repository instances.
// ABOUTME: Exercises the exact source cap on SQLite and concurrent Postgres connections.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import {
  loginAdmissionPolicy,
  prepareLoginAdmission,
  type LoginAdmissionRepository,
} from "@/auth/login-admission";
import type { LoginAdmissionDigests } from "@/auth/login-admission-digests";
import { createPostgresLoginAdmissionRepository } from "@/db/postgres/login-admission-repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteLoginAdmissionRepository } from "@/db/sqlite/login-admission-repository";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const workspaceId = "workspace_login_admission_shared";
const attemptedAt = new Date("2026-09-03T15:00:00.000Z");

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function admissionDigests(day: string): LoginAdmissionDigests {
  return Object.freeze({
    day,
    principal: digest(`${day}:principal:shared-member`),
    source: digest(`${day}:source:shared-source`),
    sourcePrincipal: digest(`${day}:pair:shared-source:shared-member`),
    workspace: digest(`${day}:workspace:${workspaceId}`),
  });
}

function sharedReservation() {
  return prepareLoginAdmission({
    attemptedAt,
    current: admissionDigests("2026-09-03"),
    previous: admissionDigests("2026-09-02"),
    workspaceId,
  });
}

async function assertSharedSourceLimit(
  name: string,
  repositories: readonly [LoginAdmissionRepository, LoginAdmissionRepository],
) {
  const results = await Promise.all(
    Array.from({ length: loginAdmissionPolicy.sourceAttemptLimit * 2 }, (_, index) =>
      repositories[index % repositories.length]!.reserve(sharedReservation()),
    ),
  );
  assert.equal(
    results.filter(({ accepted }) => accepted).length,
    loginAdmissionPolicy.sourceAttemptLimit,
    `${name} repository instances did not share the source limit`,
  );
  assert.equal(
    results.filter(
      (result) => !result.accepted && result.reason === "source",
    ).length,
    loginAdmissionPolicy.sourceAttemptLimit,
    `${name} repository instances did not return the shared source rejection`,
  );
}

test("SQLite repository instances share durable login admission limits", async () => {
  const client = new Database(":memory:");
  try {
    client.pragma("foreign_keys = ON");
    const firstDatabase = createSqliteDatabase(client, { schema: sqliteSchema });
    migrateSqlite(firstDatabase, { migrationsFolder: migrations.sqlite });
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run(workspaceId, "login-admission-shared", "Shared login admission");
    const secondDatabase = createSqliteDatabase(client, { schema: sqliteSchema });
    await assertSharedSourceLimit("SQLite", [
      createSqliteLoginAdmissionRepository(firstDatabase),
      createSqliteLoginAdmissionRepository(secondDatabase),
    ]);
  } finally {
    client.close();
  }
});

test(
  "Postgres repository instances on separate pools share login admission limits",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const firstPool = new Pool({ connectionString: container.getConnectionUri() });
    const secondPool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      const firstDatabase = createPostgresDatabase(firstPool, {
        schema: postgresSchema,
      });
      const secondDatabase = createPostgresDatabase(secondPool, {
        schema: postgresSchema,
      });
      await migratePostgres(firstDatabase, {
        migrationsFolder: migrations.postgres,
      });
      await firstPool.query(
        "insert into workspaces (id, slug, name) values ($1, $2, $3)",
        [workspaceId, "login-admission-shared", "Shared login admission"],
      );
      await assertSharedSourceLimit("Postgres", [
        createPostgresLoginAdmissionRepository(firstDatabase),
        createPostgresLoginAdmissionRepository(secondDatabase),
      ]);
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
      await container.stop();
    }
  },
);
