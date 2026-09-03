// ABOUTME: Runs durable login-admission policy checks against Postgres, SQLite, and D1 semantics.
// ABOUTME: Covers atomic caps, cooldowns, UTC key rotation, bounded cleanup, and risk signaling.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { drizzle as createD1Database } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  clearLoginFailure,
  isPrincipalLoginRiskElevated,
  loginAdmissionPolicy,
  prepareLoginAdmission,
  recordLoginFailure,
  type LoginAdmissionRepository,
} from "@/auth/login-admission";
import type { LoginAdmissionDigests } from "@/auth/login-admission-digests";
import { createPostgresLoginAdmissionRepository } from "@/db/postgres/login-admission-repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteLoginAdmissionRepository } from "@/db/sqlite/login-admission-repository";

const workspaceId = "workspace_login_admission";

type WindowSeed = Readonly<{
  blockedUntil?: Date | null;
  count: number;
  dimension: "principal" | "source" | "source_principal" | "workspace";
  expiresAt: Date;
  keyDigest: string;
  windowStartedAt: Date;
}>;

type StoredWindow = Readonly<{
  blockedUntil: number | null;
  count: number;
  dimension: string;
  expiresAt: number;
  keyDigest: string;
  windowStartedAt: number;
}>;

type Harness = Readonly<{
  close(): Promise<void>;
  insertWindow(seed: WindowSeed): Promise<void>;
  rejectWorkspaceWrites(): Promise<void>;
  repository: LoginAdmissionRepository;
  windows(): Promise<readonly StoredWindow[]>;
}>;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function dailyDigests(
  day: string,
  source: string,
  principal: string,
): LoginAdmissionDigests {
  return Object.freeze({
    day,
    principal: digest(`${day}:principal:${principal}`),
    source: digest(`${day}:source:${source}`),
    sourcePrincipal: digest(`${day}:pair:${source}:${principal}`),
    workspace: digest(`${day}:workspace:${workspaceId}`),
  });
}

function dayBefore(day: string) {
  return new Date(`${day}T00:00:00.000Z`).getTime() - 24 * 60 * 60 * 1_000;
}

function dayString(milliseconds: number) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function permit(attemptedAt: Date, source = "source-a", principal = "member-a") {
  const currentDay = dayString(attemptedAt.getTime());
  const previousDay = dayString(dayBefore(currentDay));
  return prepareLoginAdmission({
    attemptedAt,
    current: dailyDigests(currentDay, source, principal),
    previous: dailyDigests(previousDay, source, principal),
    workspaceId,
  });
}

function accepted(value: Awaited<ReturnType<LoginAdmissionRepository["reserve"]>>) {
  return value.accepted;
}

async function exerciseRepository(name: string, harness: Harness) {
  try {
    const beforeMidnight = new Date("2026-09-03T23:59:50.000Z");
    const afterMidnight = new Date("2026-09-04T00:00:10.000Z");
    const previousPermit = permit(beforeMidnight);
    const currentPermit = permit(afterMidnight);

    assert.equal(accepted(await harness.repository.reserve(previousPermit)), true, name);
    assert.equal(accepted(await harness.repository.reserve(currentPermit)), true, name);

    const previousSource = previousPermit.current.source;
    const previousWorkspace = previousPermit.current.workspace;
    const midnightWindows = await harness.windows();
    assert.deepEqual(
      midnightWindows
        .filter(
          (row) =>
            row.keyDigest === previousSource || row.keyDigest === previousWorkspace,
        )
        .map((row) => [row.dimension, row.count, row.keyDigest])
        .sort(),
      [
        ["source", 2, previousSource],
        ["workspace", 2, previousWorkspace],
      ],
      `${name} must continue active prior-day windows`,
    );
    assert.equal(
      midnightWindows.some(
        (row) =>
          row.keyDigest === currentPermit.current.source ||
          row.keyDigest === currentPermit.current.workspace,
      ),
      false,
      `${name} must not reset active windows at midnight`,
    );

    const firstFailureAt = new Date("2026-09-04T00:00:10.100Z");
    const firstFailure = await recordLoginFailure(
      harness.repository,
      previousPermit,
      firstFailureAt,
    );
    assert.deepEqual(
      {
        blockedUntil: firstFailure.blockedUntil.toISOString(),
        failureCount: firstFailure.failureCount,
        principalRiskCount: firstFailure.principalRiskCount,
        principalRiskElevated: firstFailure.principalRiskElevated,
      },
      {
        blockedUntil: "2026-09-04T00:01:10.100Z",
        failureCount: 1,
        principalRiskCount: 1,
        principalRiskElevated: false,
      },
      name,
    );

    const countsBeforeBlocked = (await harness.windows())
      .filter((row) => row.dimension === "source" || row.dimension === "workspace")
      .reduce((sum, row) => sum + row.count, 0);
    const blocked = await harness.repository.reserve(
      permit(new Date("2026-09-04T00:00:20.000Z")),
    );
    assert.deepEqual(
      blocked,
      {
        accepted: false,
        reason: "source_principal",
        retryAfterAt: new Date("2026-09-04T00:01:10.100Z"),
      },
      name,
    );
    const countsAfterBlocked = (await harness.windows())
      .filter((row) => row.dimension === "source" || row.dimension === "workspace")
      .reduce((sum, row) => sum + row.count, 0);
    assert.equal(
      countsAfterBlocked,
      countsBeforeBlocked,
      `${name} blocked attempts must not extend counters`,
    );

    const recoveredPermit = permit(new Date("2026-09-04T00:01:10.101Z"));
    assert.equal(accepted(await harness.repository.reserve(recoveredPermit)), true, name);
    assert.equal(
      await clearLoginFailure(
        harness.repository,
        recoveredPermit,
        new Date("2026-09-04T00:01:10.200Z"),
      ),
      1,
      `${name} must clear the prior-day pair digest`,
    );
    assert.equal(
      (await harness.windows()).some(
        (row) => row.dimension === "source_principal",
      ),
      false,
      name,
    );
    assert.equal(
      (await harness.windows()).some((row) => row.dimension === "principal"),
      true,
      `${name} successful login must retain the informational principal counter`,
    );

    const capAt = new Date("2026-09-04T01:00:00.000Z");
    const capPermit = permit(capAt, "source-cap", "member-cap");
    const capResults = await Promise.all(
      Array.from({ length: 40 }, () => harness.repository.reserve(capPermit)),
    );
    assert.equal(
      capResults.filter((result) => result.accepted).length,
      loginAdmissionPolicy.sourceAttemptLimit,
      `${name} source cap must be exact under concurrent callers`,
    );
    assert.equal(
      capResults.filter(
        (result) => !result.accepted && result.reason === "source",
      ).length,
      20,
      name,
    );
    const capRows = await harness.windows();
    assert.equal(
      capRows.find(
        (row) =>
          row.dimension === "source" &&
          row.keyDigest === capPermit.current.source,
      )?.count,
      20,
      name,
    );
    assert.equal(
      capRows.find(
        (row) =>
          row.dimension === "workspace" &&
          row.keyDigest === capPermit.current.workspace,
      )?.count,
      20,
      `${name} rejected source attempts must not consume workspace capacity`,
    );

    const riskAt = new Date("2026-09-04T02:00:00.000Z");
    const riskPermit = permit(riskAt, "source-risk", "member-risk");
    assert.equal(accepted(await harness.repository.reserve(riskPermit)), true, name);
    await harness.insertWindow({
      count: 28,
      dimension: "principal",
      expiresAt: new Date("2026-09-04T03:00:00.000Z"),
      keyDigest: riskPermit.current.principal,
      windowStartedAt: riskAt,
    });
    const risk29 = await recordLoginFailure(harness.repository, riskPermit, riskAt);
    const risk30 = await recordLoginFailure(harness.repository, riskPermit, riskAt);
    const risk31 = await recordLoginFailure(harness.repository, riskPermit, riskAt);
    assert.deepEqual(
      [risk29, risk30, risk31].map((state) => [
        state.principalRiskCount,
        state.principalRiskElevated,
      ]),
      [
        [29, false],
        [30, true],
        [31, true],
      ],
      `${name} principal risk is informational at the exact boundary`,
    );
    assert.deepEqual(
      [risk29, risk30, risk31].map((state) => state.blockedUntil.toISOString()),
      [
        "2026-09-04T02:01:00.000Z",
        "2026-09-04T02:02:00.000Z",
        "2026-09-04T02:04:00.000Z",
      ],
      `${name} pair cooldown must start at one, two, then four minutes`,
    );
    const risk32 = await recordLoginFailure(harness.repository, riskPermit, riskAt);
    const risk33 = await recordLoginFailure(harness.repository, riskPermit, riskAt);
    assert.deepEqual(
      [risk32, risk33].map((state) => state.blockedUntil.toISOString()),
      ["2026-09-04T02:08:00.000Z", "2026-09-04T02:15:00.000Z"],
      `${name} pair cooldown must finish at eight and fifteen minutes`,
    );
    assert.equal(
      accepted(
        await harness.repository.reserve(
          permit(
            new Date("2026-09-04T02:00:00.001Z"),
            "different-source",
            "member-risk",
          ),
        ),
      ),
      true,
      `${name} principal risk must not lock a different source`,
    );

    const workspaceAt = new Date("2026-09-04T04:00:00.000Z");
    const firstWorkspacePermit = permit(
      workspaceAt,
      "workspace-source-a",
      "workspace-member-a",
    );
    await harness.insertWindow({
      count: loginAdmissionPolicy.workspaceAttemptLimit - 1,
      dimension: "workspace",
      expiresAt: new Date("2026-09-04T04:01:00.000Z"),
      keyDigest: firstWorkspacePermit.current.workspace,
      windowStartedAt: workspaceAt,
    });
    assert.equal(
      accepted(await harness.repository.reserve(firstWorkspacePermit)),
      true,
      name,
    );
    const secondWorkspacePermit = permit(
      new Date("2026-09-04T04:00:00.001Z"),
      "workspace-source-b",
      "workspace-member-b",
    );
    const workspaceRejected = await harness.repository.reserve(
      secondWorkspacePermit,
    );
    assert.equal(workspaceRejected.accepted, false, name);
    if (!workspaceRejected.accepted) {
      assert.equal(workspaceRejected.reason, "workspace", name);
    }
    const workspaceRows = await harness.windows();
    assert.equal(
      workspaceRows.find(
        (row) =>
          row.dimension === "workspace" &&
          row.keyDigest === firstWorkspacePermit.current.workspace,
      )?.count,
      600,
      name,
    );
    assert.equal(
      workspaceRows.some(
        (row) =>
          row.dimension === "source" &&
          row.keyDigest === secondWorkspacePermit.current.source,
      ),
      false,
      `${name} rejected workspace reservations must not consume source capacity`,
    );

    const corruptPairAt = new Date("2026-09-04T05:00:00.000Z");
    const corruptPairPermit = permit(
      corruptPairAt,
      "corrupt-pair-source",
      "corrupt-pair-member",
    );
    for (const [index, keyDigest] of [
      corruptPairPermit.current.sourcePrincipal,
      corruptPairPermit.previous.sourcePrincipal,
    ].entries()) {
      await harness.insertWindow({
        blockedUntil: new Date(corruptPairAt.getTime() - 1),
        count: 1,
        dimension: "source_principal",
        expiresAt: new Date(corruptPairAt.getTime() + 15 * 60 * 1_000),
        keyDigest,
        windowStartedAt: new Date(corruptPairAt.getTime() - 1_000 - index),
      });
    }
    const corruptPairResult = await harness.repository.reserve(corruptPairPermit);
    assert.deepEqual(
      corruptPairResult,
      {
        accepted: false,
        reason: "integrity",
        retryAfterAt: new Date(corruptPairAt.getTime() + 60 * 1_000),
      },
      `${name} must fail closed when both rotating pair rows are active`,
    );
    assert.equal(
      (await harness.windows()).some(
        (row) =>
          (row.dimension === "source" &&
            row.keyDigest === corruptPairPermit.current.source) ||
          (row.dimension === "workspace" &&
            row.keyDigest === corruptPairPermit.current.workspace),
      ),
      false,
      `${name} corrupt pair state must not consume reservation capacity`,
    );

    const cleanupAt = new Date("2026-09-04T06:00:00.000Z");
    for (let index = 0; index < 105; index += 1) {
      const startedAt = new Date(
        cleanupAt.getTime() - 2 * 60 * 60 * 1_000 + index,
      );
      await harness.insertWindow({
        count: 1,
        dimension: "source",
        expiresAt: new Date(startedAt.getTime() + 60_000),
        keyDigest: digest(`expired:${name}:${index}`),
        windowStartedAt: startedAt,
      });
    }
    const expiredBeforeCleanup = (await harness.windows()).filter(
      (row) => row.expiresAt <= cleanupAt.getTime(),
    ).length;
    assert.equal(
      accepted(
        await harness.repository.reserve(
          permit(cleanupAt, "cleanup-source", "cleanup-member"),
        ),
      ),
      true,
      name,
    );
    assert.equal(
      (await harness.windows()).filter((row) => row.expiresAt <= cleanupAt.getTime())
        .length,
      expiredBeforeCleanup - loginAdmissionPolicy.cleanupLimit,
      `${name} cleanup must delete at most 100 rows`,
    );
    assert.equal(
      (await harness.windows()).every(
        (row) => row.expiresAt - row.windowStartedAt <= 24 * 60 * 60 * 1_000,
      ),
      true,
      `${name} login rows must expire within 24 hours`,
    );
    assert.equal(
      (await harness.windows()).every((row) =>
        row.dimension === "source_principal"
          ? row.blockedUntil !== null
          : row.blockedUntil === null,
      ),
      true,
      `${name} must not persist transaction markers`,
    );
  } finally {
    await harness.close();
  }
}

function sqliteSchemaSql() {
  return `
    create table workspaces (
      id text primary key not null,
      slug text not null unique,
      name text not null
    );
    create table admin_login_windows (
      workspace_id text not null references workspaces(id) on delete cascade,
      dimension text not null check (
        dimension in ('source', 'source_principal', 'principal', 'workspace')
      ),
      key_digest text not null check (
        length(key_digest) = 64
        and key_digest = lower(key_digest)
        and key_digest not glob '*[^0-9a-f]*'
      ),
      window_started_at integer not null,
      count integer not null default 0 check (count >= 0),
      blocked_until integer,
      expires_at integer not null,
      primary key (workspace_id, dimension, key_digest, window_started_at),
      check (
        expires_at > window_started_at
        and expires_at <= window_started_at + 86400000
        and (
          blocked_until is null
          or (
            blocked_until >= window_started_at
            and blocked_until <= expires_at
          )
        )
      )
    );
  `;
}

type D1Bound = Readonly<{
  all(): Promise<unknown>;
  execute(): unknown;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}>;

function createD1Facade(client: Database.Database) {
  const result = (results: unknown[], changes = 0) => ({
    meta: { changes },
    results,
    success: true,
  });
  const d1 = {
    prepare(source: string) {
      return {
        bind(...parameters: unknown[]): D1Bound {
          const returnsRows =
            /^\s*(?:select|with)\b/iu.test(source) || /\breturning\b/iu.test(source);
          const execute = () => {
            if (returnsRows) {
              return result(client.prepare(source).all(...parameters) as unknown[]);
            }
            const changed = client.prepare(source).run(...parameters);
            return result([], changed.changes);
          };
          return {
            async all() {
              return execute();
            },
            execute,
            async first<T>() {
              return (
                (client.prepare(source).get(...parameters) as T | undefined) ?? null
              );
            },
            async run() {
              return execute();
            },
          };
        },
      };
    },
    async batch(statements: readonly D1Bound[]) {
      return client.transaction((items: readonly D1Bound[]) =>
        items.map((statement) => statement.execute()),
      )(statements);
    },
  } as unknown as AnyD1Database;
  return createD1Database(d1, { schema: sqliteSchema });
}

function sqliteHarness(mode: "D1" | "SQLite"): Harness {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  client.exec(sqliteSchemaSql());
  client
    .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
    .run(workspaceId, "login-admission", "Login admission");
  const database =
    mode === "D1"
      ? createD1Facade(client)
      : createSqliteDatabase(client, { schema: sqliteSchema });

  return {
    async close() {
      client.close();
    },
    async insertWindow(seed) {
      client
        .prepare(
          `insert into admin_login_windows (
            workspace_id, dimension, key_digest, window_started_at,
            count, blocked_until, expires_at
          ) values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          seed.dimension,
          seed.keyDigest,
          seed.windowStartedAt.getTime(),
          seed.count,
          seed.blockedUntil?.getTime() ?? null,
          seed.expiresAt.getTime(),
        );
    },
    async rejectWorkspaceWrites() {
      client.exec(`
        create trigger reject_workspace_login_window_insert
        before insert on admin_login_windows
        when new.dimension = 'workspace'
        begin
          select raise(abort, 'WORKSPACE_WRITE_REJECTED');
        end;
        create trigger reject_workspace_login_window_update
        before update on admin_login_windows
        when new.dimension = 'workspace'
        begin
          select raise(abort, 'WORKSPACE_WRITE_REJECTED');
        end;
      `);
    },
    repository: createSqliteLoginAdmissionRepository(database),
    async windows() {
      return client
        .prepare(
          `select
            dimension,
            key_digest as keyDigest,
            window_started_at as windowStartedAt,
            count,
            blocked_until as blockedUntil,
            expires_at as expiresAt
          from admin_login_windows
          where workspace_id = ?
          order by dimension, window_started_at, key_digest`,
        )
        .all(workspaceId) as StoredWindow[];
    },
  };
}

async function postgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  const unexpectedPoolErrors: Error[] = [];
  let closing = false;
  pool.on("error", (error) => {
    if (!closing) unexpectedPoolErrors.push(error);
  });
  await pool.query(`
    create table workspaces (
      id text primary key not null,
      slug text not null unique,
      name text not null
    );
    create table admin_login_windows (
      workspace_id text not null references workspaces(id) on delete cascade,
      dimension text not null check (
        dimension in ('source', 'source_principal', 'principal', 'workspace')
      ),
      key_digest text not null check (
        length(key_digest) = 64
        and key_digest = lower(key_digest)
        and key_digest ~ '^[0-9a-f]{64}$'
      ),
      window_started_at timestamp with time zone not null,
      count integer not null default 0 check (count >= 0),
      blocked_until timestamp with time zone,
      expires_at timestamp with time zone not null,
      primary key (workspace_id, dimension, key_digest, window_started_at),
      check (
        expires_at > window_started_at
        and expires_at <= window_started_at + interval '24 hours'
        and (
          blocked_until is null
          or (
            blocked_until >= window_started_at
            and blocked_until <= expires_at
          )
        )
      )
    );
  `);
  await pool.query(
    "insert into workspaces (id, slug, name) values ($1, $2, $3)",
    [workspaceId, "login-admission", "Login admission"],
  );
  const database = createPostgresDatabase(pool, { schema: postgresSchema });

  return {
    async close() {
      const unexpectedPoolError = unexpectedPoolErrors[0];
      closing = true;
      await pool.end();
      await container.stop();
      if (unexpectedPoolError) throw unexpectedPoolError;
    },
    async insertWindow(seed) {
      await pool.query(
        `insert into admin_login_windows (
          workspace_id, dimension, key_digest, window_started_at,
          count, blocked_until, expires_at
        ) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          workspaceId,
          seed.dimension,
          seed.keyDigest,
          seed.windowStartedAt,
          seed.count,
          seed.blockedUntil ?? null,
          seed.expiresAt,
        ],
      );
    },
    repository: createPostgresLoginAdmissionRepository(database),
    async rejectWorkspaceWrites() {
      throw new Error("Postgres rollback injection is not used by this contract.");
    },
    async windows() {
      const result = await pool.query<{
        blockedUntil: Date | null;
        count: number;
        dimension: string;
        expiresAt: Date;
        keyDigest: string;
        windowStartedAt: Date;
      }>(`
        select
          dimension,
          key_digest as "keyDigest",
          window_started_at as "windowStartedAt",
          count,
          blocked_until as "blockedUntil",
          expires_at as "expiresAt"
        from admin_login_windows
        where workspace_id = $1
        order by dimension, window_started_at, key_digest
      `, [workspaceId]);
      return result.rows.map((row) => ({
        ...row,
        blockedUntil: row.blockedUntil?.getTime() ?? null,
        expiresAt: row.expiresAt.getTime(),
        windowStartedAt: row.windowStartedAt.getTime(),
      }));
    },
  };
}

test("principal risk becomes informationally elevated at 30 failures", () => {
  assert.equal(isPrincipalLoginRiskElevated(29), false);
  assert.equal(isPrincipalLoginRiskElevated(30), true);
  assert.equal(isPrincipalLoginRiskElevated(31), true);
  assert.throws(() => isPrincipalLoginRiskElevated(-1));
});

test("login admission rejects mismatched UTC digest days", () => {
  const attemptedAt = new Date("2026-09-04T00:00:00.000Z");
  assert.throws(
    () =>
      prepareLoginAdmission({
        attemptedAt,
        current: dailyDigests("2026-09-03", "source", "member"),
        previous: dailyDigests("2026-09-02", "source", "member"),
        workspaceId,
      }),
    /INVALID_LOGIN_ADMISSION_DAY_PAIR/u,
  );
});

test("login admission contract passes on SQLite", async () => {
  await exerciseRepository("SQLite", sqliteHarness("SQLite"));
});

test("login admission contract passes through D1 batch semantics", async () => {
  await exerciseRepository("D1", sqliteHarness("D1"));
});

for (const mode of ["SQLite", "D1"] as const) {
  test(`${mode} rolls back a source marker when workspace reservation fails`, async () => {
    const harness = sqliteHarness(mode);
    try {
      await harness.rejectWorkspaceWrites();
      await assert.rejects(
        harness.repository.reserve(
          permit(
            new Date("2026-09-04T12:00:00.000Z"),
            "rollback-source",
            "rollback-member",
          ),
        ),
      );
      assert.deepEqual(await harness.windows(), []);
    } finally {
      await harness.close();
    }
  });
}

test(
  "login admission contract serializes real Postgres callers",
  { timeout: 120_000 },
  async () => {
    await exerciseRepository("Postgres", await postgresHarness());
  },
);

test("Neon login admission uses one transactional batch", async () => {
  const calls: unknown[][] = [];
  const database = {
    async batch(queries: unknown[]) {
      calls.push(queries);
      return [
        { rows: [{}] },
        { rows: [] },
        { rows: [{ accepted: true, reason: null, retryAfterAt: null }] },
      ];
    },
    execute(statement: unknown) {
      return { statement };
    },
  };
  const repository = createPostgresLoginAdmissionRepository(database as never);
  assert.equal(
    accepted(
      await repository.reserve(
        permit(new Date("2026-09-04T12:00:00.000Z")),
      ),
    ),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 3);
});
