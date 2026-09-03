// ABOUTME: Verifies operator bootstrap and recovery against Postgres, SQLite, and D1 transactions.
// ABOUTME: Covers one-time setup, rollback, recovery replacement, bearer containment, and races.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

import {
  issueOperatorRecovery,
  OperatorIdentityError,
  type OperatorBootstrapRecord,
  type OperatorIdentityRepository,
  type OperatorRecoveryRecord,
} from "@/auth/operator-identity";
import { verifyMemberPassword } from "@/auth/member-password";
import { createPostgresOperatorIdentityRepository } from "@/db/postgres/operator-identity-repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteOperatorIdentityRepository } from "@/db/sqlite/operator-identity-repository";
import { createSqliteTeamAuthoringBackfillStore } from "@/db/sqlite/team-authoring-backfill";
import { runTeamAuthoringBackfill } from "@/db/team-authoring-backfill";
import {
  type AuthoringControl,
  type AuthoringControlStore,
  runAuthoringControlCommand,
} from "../scripts/authoring-control";
import {
  openRecoveryArtifact,
  parseOperatorIdentityCommand,
  runOperatorIdentityCommand,
} from "../scripts/operator-identity";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const fixedTime = new Date("2026-09-03T12:00:00.000Z");
const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const fixedPassword = Object.freeze({
  digest: "d".repeat(43),
  iterations: 600_000,
  salt: "s".repeat(43),
});

type StoredMember = Readonly<{
  createdByMemberId: string | null;
  displayName: string;
  id: string;
  normalizedEmail: string;
  passwordDigest: string;
  passwordIterations: number;
  passwordSalt: string;
  role: string;
  status: string;
  workspaceId: string;
}>;

type StoredInvitation = Readonly<{
  acceptedAt: Date | null;
  createdAt: Date;
  createdByMemberId: string | null;
  expiresAt: Date;
  id: string;
  kind: string;
  memberId: string | null;
  normalizedEmail: string;
  revokedAt: Date | null;
  targetRole: string | null;
  tokenDigest: string;
  workspaceId: string;
}>;

type RepositoryHarness = Readonly<{
  close(): Promise<void>;
  counts(): Promise<Readonly<{ controls: number; members: number; workspaces: number }>>;
  createMember(input: Readonly<{
    createdByMemberId: string;
    email: string;
    id: string;
    role: "administrator" | "reviewer";
    status: "active" | "disabled";
    workspaceId: string;
  }>): Promise<void>;
  createSession(workspaceId: string, memberId: string): Promise<void>;
  createWorkspace(input: Readonly<{
    id: string;
    name?: string;
    paused?: boolean;
    slug: string;
  }>): Promise<void>;
  installBootstrapFailure(): Promise<void>;
  invitations(workspaceId: string): Promise<readonly StoredInvitation[]>;
  member(workspaceId: string): Promise<StoredMember | null>;
  removeBootstrapFailure(): Promise<void>;
  repository: OperatorIdentityRepository;
  sessionRevoked(): Promise<boolean>;
}>;

function bootstrapRecord(
  memberId: string,
  workspaceReference: string,
  workspaceCreation: OperatorBootstrapRecord["workspaceCreation"],
  email = `${memberId}@example.test`,
): OperatorBootstrapRecord {
  return Object.freeze({
    createdAt: fixedTime,
    displayName: "Operator Admin",
    memberId,
    normalizedEmail: email,
    password: fixedPassword,
    workspaceCreation,
    workspaceReference,
  });
}

function recoveryRecord(
  input: Readonly<{
    digestCharacter: string;
    id: string;
    kind: "credential_reset" | "invite";
    member?: string;
    email?: string;
    time?: Date;
    workspaceReference: string;
  }>,
): OperatorRecoveryRecord {
  const createdAt = input.time ?? fixedTime;
  return Object.freeze({
    createdAt,
    expiresAt: new Date(
      createdAt.getTime() + (input.kind === "invite" ? 2 * day : hour),
    ),
    recordId: input.id,
    target:
      input.kind === "invite"
        ? {
            kind: "invite" as const,
            normalizedEmail: input.email ?? "invited@example.test",
          }
        : {
            kind: "credential_reset" as const,
            memberReference: {
              field: "id" as const,
              value: input.member ?? "member_missing",
            },
          },
    tokenDigest: input.digestCharacter.repeat(64),
    workspaceReference: input.workspaceReference,
  });
}

async function exerciseRepository(harness: RepositoryHarness) {
  try {
    await harness.installBootstrapFailure();
    await assert.rejects(
      harness.repository.bootstrap(
        bootstrapRecord("member_rollback", "clean", {
          id: "workspace_clean",
          name: "Clean",
          slug: "clean",
        }, "fail@example.test"),
      ),
    );
    assert.deepEqual(await harness.counts(), {
      controls: 0,
      members: 0,
      workspaces: 0,
    });
    await harness.removeBootstrapFailure();

    const creation = {
      id: "workspace_clean",
      name: "Clean",
      slug: "clean",
    } as const;
    const raced = await Promise.all([
      harness.repository.bootstrap(
        bootstrapRecord("member_clean_one", "clean", creation),
      ),
      harness.repository.bootstrap(
        bootstrapRecord("member_clean_two", "clean", creation),
      ),
    ]);
    assert.equal(raced.filter((result) => result.outcome === "created").length, 1);
    assert.equal(
      raced.filter((result) => result.outcome === "already_bootstrapped").length,
      1,
    );
    const created = raced.find((result) => result.outcome === "created");
    assert.ok(created && created.outcome === "created");
    assert.equal(created.workspaceCreated, true);
    assert.equal(created.workspaceId, creation.id);
    assert.deepEqual(await harness.counts(), {
      controls: 1,
      members: 1,
      workspaces: 1,
    });
    const firstMember = await harness.member(creation.id);
    assert.ok(firstMember);
    assert.deepEqual(firstMember, {
      createdByMemberId: null,
      displayName: "Operator Admin",
      id: created.memberId,
      normalizedEmail: `${created.memberId}@example.test`,
      passwordDigest: fixedPassword.digest,
      passwordIterations: fixedPassword.iterations,
      passwordSalt: fixedPassword.salt,
      role: "administrator",
      status: "active",
      workspaceId: creation.id,
    });

    await harness.createWorkspace({
      id: "workspace_upgrade",
      name: "Upgrade",
      paused: true,
      slug: "upgrade",
    });
    const upgrade = await harness.repository.bootstrap(
      bootstrapRecord("member_upgrade", "upgrade", {
        id: "workspace_upgrade",
        name: "Upgrade",
        slug: "upgrade",
      }),
    );
    assert.deepEqual(upgrade, {
      memberId: "member_upgrade",
      outcome: "created",
      workspaceCreated: false,
      workspaceId: "workspace_upgrade",
    });

    await harness.createWorkspace({ id: "workspace_partial", slug: "partial" });
    assert.deepEqual(
      await harness.repository.bootstrap(
        bootstrapRecord("member_partial", "partial", null),
      ),
      { outcome: "partial_state" },
    );
    await harness.createWorkspace({
      id: "workspace_unpaused",
      paused: false,
      slug: "unpaused",
    });
    assert.deepEqual(
      await harness.repository.bootstrap(
        bootstrapRecord("member_unpaused", "unpaused", {
          id: "workspace_unpaused",
          name: "workspace_unpaused",
          slug: "unpaused",
        }),
      ),
      { outcome: "partial_state" },
    );
    await harness.createWorkspace({
      id: "ambiguous_reference",
      paused: true,
      slug: "ambiguous-left",
    });
    await harness.createWorkspace({
      id: "ambiguous-right",
      paused: true,
      slug: "ambiguous_reference",
    });
    assert.deepEqual(
      await harness.repository.bootstrap(
        bootstrapRecord("member_ambiguous", "ambiguous_reference", null),
      ),
      { outcome: "ambiguous" },
    );
    assert.deepEqual(
      await harness.repository.bootstrap(
        bootstrapRecord("member_missing", "missing", {
          id: "workspace_missing",
          name: "Missing",
          slug: "missing",
        }),
      ),
      { outcome: "not_empty" },
    );

    await harness.createSession(creation.id, created.memberId);
    const firstReset = recoveryRecord({
      digestCharacter: "1",
      id: "reset_one",
      kind: "credential_reset",
      member: created.memberId,
      workspaceReference: "clean",
    });
    assert.deepEqual(await harness.repository.issueRecovery(firstReset), {
      outcome: "created",
      workspaceId: creation.id,
    });
    assert.equal(await harness.sessionRevoked(), true);
    const resetRows = await harness.invitations(creation.id);
    assert.equal(resetRows.length, 1);
    assert.deepEqual(resetRows[0], {
      acceptedAt: null,
      createdAt: fixedTime,
      createdByMemberId: null,
      expiresAt: new Date(fixedTime.getTime() + hour),
      id: "reset_one",
      kind: "credential_reset",
      memberId: created.memberId,
      normalizedEmail: `${created.memberId}@example.test`,
      revokedAt: null,
      targetRole: null,
      tokenDigest: "1".repeat(64),
      workspaceId: creation.id,
    });

    const replacementTime = new Date(fixedTime.getTime() + 1_000);
    assert.deepEqual(
      await harness.repository.issueRecovery(
        recoveryRecord({
          digestCharacter: "2",
          id: "reset_two",
          kind: "credential_reset",
          member: created.memberId,
          time: replacementTime,
          workspaceReference: creation.id,
        }),
      ),
      { outcome: "created", workspaceId: creation.id },
    );
    const replaced = await harness.invitations(creation.id);
    assert.equal(replaced.length, 2);
    assert.equal(replaced.find((row) => row.id === "reset_one")?.revokedAt?.getTime(), replacementTime.getTime());
    assert.equal(replaced.find((row) => row.id === "reset_two")?.revokedAt, null);

    assert.deepEqual(
      await harness.repository.issueRecovery(
        recoveryRecord({
          digestCharacter: "2",
          id: "reset_two",
          kind: "credential_reset",
          member: created.memberId,
          time: replacementTime,
          workspaceReference: creation.id,
        }),
      ),
      { outcome: "collision" },
    );

    const rowsBeforeDeliveryFailure = (await harness.invitations(creation.id)).length;
    await assert.rejects(
      issueOperatorRecovery(
        harness.repository,
        {
          kind: "credential_reset",
          member: created.memberId,
          siteOrigin: "https://demo.opas.dev",
          workspaceReference: creation.id,
        },
        async () => {
          throw new Error("simulated artifact write failure");
        },
        {
          clock: () => new Date(fixedTime.getTime() + 2_000),
          randomBytes: deterministicRandom(20),
        },
      ),
      /RECOVERY_DELIVERY_FAILED/u,
    );
    const rowsAfterDeliveryFailure = await harness.invitations(creation.id);
    assert.equal(rowsAfterDeliveryFailure.length, rowsBeforeDeliveryFailure + 1);
    assert.equal(
      rowsAfterDeliveryFailure.filter((row) => row.revokedAt === null).length,
      0,
    );

    await harness.createMember({
      createdByMemberId: created.memberId,
      email: "reviewer@example.test",
      id: "member_reviewer",
      role: "reviewer",
      status: "active",
      workspaceId: creation.id,
    });
    await harness.createMember({
      createdByMemberId: created.memberId,
      email: "disabled@example.test",
      id: "member_disabled",
      role: "administrator",
      status: "disabled",
      workspaceId: creation.id,
    });
    for (const member of ["member_reviewer", "member_disabled", "member_absent"]) {
      assert.deepEqual(
        await harness.repository.issueRecovery(
          recoveryRecord({
            digestCharacter: "3",
            id: `reset_${member}`,
            kind: "credential_reset",
            member,
            workspaceReference: creation.id,
          }),
        ),
        { outcome: "not_found" },
      );
    }
    assert.deepEqual(
      await harness.repository.issueRecovery(
        recoveryRecord({
          digestCharacter: "4",
          email: "second-admin@example.test",
          id: "established_invite",
          kind: "invite",
          workspaceReference: creation.id,
        }),
      ),
      { outcome: "partial_state" },
    );

    await harness.createWorkspace({
      id: "workspace_recovery",
      paused: true,
      slug: "recovery",
    });
    assert.deepEqual(
      await harness.repository.issueRecovery(
        recoveryRecord({
          digestCharacter: "5",
          email: "first-admin@example.test",
          id: "bootstrap_invite",
          kind: "invite",
          workspaceReference: "recovery",
        }),
      ),
      { outcome: "created", workspaceId: "workspace_recovery" },
    );
    const invite = (await harness.invitations("workspace_recovery"))[0];
    assert.ok(invite);
    assert.equal(invite.createdByMemberId, null);
    assert.equal(invite.memberId, null);
    assert.equal(invite.targetRole, "administrator");
    assert.equal(invite.expiresAt.getTime() - invite.createdAt.getTime(), 2 * day);

    assert.deepEqual(
      await harness.repository.issueRecovery(
        recoveryRecord({
          digestCharacter: "6",
          email: "partial@example.test",
          id: "partial_invite",
          kind: "invite",
          workspaceReference: "partial",
        }),
      ),
      { outcome: "partial_state" },
    );
  } finally {
    await harness.close();
  }
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
            const mutation = client.prepare(source).run(...parameters);
            return result([], mutation.changes);
          };
          return {
            async all() {
              return execute();
            },
            execute,
            async first<T>() {
              return (client.prepare(source).get(...parameters) as T | undefined) ?? null;
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

function sqliteHarness(useD1: boolean): RepositoryHarness {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const local = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(local, { migrationsFolder: migrations.sqlite });
  const database = useD1 ? createD1Facade(client) : local;

  return {
    async close() {
      client.close();
    },
    async counts() {
      return {
        controls: (client.prepare("select count(*) as count from workspace_authoring_controls").get() as { count: number }).count,
        members: (client.prepare("select count(*) as count from workspace_members").get() as { count: number }).count,
        workspaces: (client.prepare("select count(*) as count from workspaces").get() as { count: number }).count,
      };
    },
    async createMember(input) {
      client.prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, ?, 'Fixture member', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.workspaceId,
        input.email,
        input.role,
        input.status,
        fixedPassword.salt,
        fixedPassword.digest,
        fixedPassword.iterations,
        input.createdByMemberId,
        fixedTime.getTime(),
        fixedTime.getTime(),
      );
    },
    async createSession(workspaceId, memberId) {
      client.prepare(
        `insert into admin_sessions
           (id, workspace_id, member_id, created_at, expires_at, revoked_at)
         values (?, ?, ?, ?, ?, null)`,
      ).run(
        "S".repeat(43),
        workspaceId,
        memberId,
        fixedTime.getTime(),
        fixedTime.getTime() + hour,
      );
    },
    async createWorkspace(input) {
      client.prepare(
        "insert into workspaces (id, slug, name, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ).run(
        input.id,
        input.slug,
        input.name ?? input.id,
        fixedTime.getTime(),
        fixedTime.getTime(),
      );
      if (input.paused === undefined) {
        client.prepare(
          "delete from workspace_authoring_controls where workspace_id = ?",
        ).run(input.id);
      } else {
        client.prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = 0,
               changed_by_member_id = null, changed_at = ?
           where workspace_id = ?`,
        ).run(input.paused ? 1 : 0, fixedTime.getTime(), input.id);
      }
    },
    async installBootstrapFailure() {
      client.exec(`
        create trigger operator_bootstrap_test_failure
        before insert on workspace_members
        for each row when new.normalized_email = 'fail@example.test'
        begin
          select raise(abort, 'BOOTSTRAP_TEST_FAILURE');
        end
      `);
    },
    async invitations(workspaceId) {
      return (client.prepare(
        `select
           id,
           workspace_id as workspaceId,
           kind,
           normalized_email as normalizedEmail,
           target_role as targetRole,
           member_id as memberId,
           token_digest as tokenDigest,
           created_by_member_id as createdByMemberId,
           created_at as createdAt,
           expires_at as expiresAt,
           accepted_at as acceptedAt,
           revoked_at as revokedAt
         from member_invitations where workspace_id = ? order by created_at, id`,
      ).all(workspaceId) as Array<Record<string, unknown>>).map((row) => ({
        ...(row as Omit<StoredInvitation, "acceptedAt" | "createdAt" | "expiresAt" | "revokedAt">),
        acceptedAt: row.acceptedAt === null ? null : new Date(Number(row.acceptedAt)),
        createdAt: new Date(Number(row.createdAt)),
        expiresAt: new Date(Number(row.expiresAt)),
        revokedAt: row.revokedAt === null ? null : new Date(Number(row.revokedAt)),
      }));
    },
    async member(workspaceId) {
      return (client.prepare(
        `select
           id,
           workspace_id as workspaceId,
           normalized_email as normalizedEmail,
           display_name as displayName,
           role,
           status,
           password_salt as passwordSalt,
           password_digest as passwordDigest,
           password_iterations as passwordIterations,
           created_by_member_id as createdByMemberId
         from workspace_members where workspace_id = ? order by id limit 1`,
      ).get(workspaceId) as StoredMember | undefined) ?? null;
    },
    async removeBootstrapFailure() {
      client.exec("drop trigger operator_bootstrap_test_failure");
    },
    repository: createSqliteOperatorIdentityRepository(database),
    async sessionRevoked() {
      const row = client.prepare(
        "select revoked_at as revokedAt from admin_sessions where id = ?",
      ).get("S".repeat(43)) as { revokedAt: number | null };
      return row.revokedAt !== null;
    },
  };
}

async function postgresHarness(): Promise<RepositoryHarness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  await migratePostgres(database, { migrationsFolder: migrations.postgres });

  return {
    async close() {
      await pool.end();
      await container.stop();
    },
    async counts() {
      const result = await pool.query<{
        controls: string;
        members: string;
        workspaces: string;
      }>(`select
           (select count(*) from workspace_authoring_controls) as controls,
           (select count(*) from workspace_members) as members,
           (select count(*) from workspaces) as workspaces`);
      const row = result.rows[0]!;
      return {
        controls: Number(row.controls),
        members: Number(row.members),
        workspaces: Number(row.workspaces),
      };
    },
    async createMember(input) {
      await pool.query(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values ($1, $2, $3, 'Fixture member', $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          input.id,
          input.workspaceId,
          input.email,
          input.role,
          input.status,
          fixedPassword.salt,
          fixedPassword.digest,
          fixedPassword.iterations,
          input.createdByMemberId,
          fixedTime,
        ],
      );
    },
    async createSession(workspaceId, memberId) {
      await pool.query(
        `insert into admin_sessions
           (id, workspace_id, member_id, created_at, expires_at, revoked_at)
         values ($1, $2, $3, $4, $5, null)`,
        ["S".repeat(43), workspaceId, memberId, fixedTime, new Date(fixedTime.getTime() + hour)],
      );
    },
    async createWorkspace(input) {
      await pool.query(
        "insert into workspaces (id, slug, name, created_at, updated_at) values ($1, $2, $3, $4, $4)",
        [input.id, input.slug, input.name ?? input.id, fixedTime],
      );
      if (input.paused === undefined) {
        await pool.query(
          "delete from workspace_authoring_controls where workspace_id = $1",
          [input.id],
        );
      } else {
        await pool.query(
          `update workspace_authoring_controls
           set writes_paused = $2, generation = 0,
               changed_by_member_id = null, changed_at = $3
           where workspace_id = $1`,
          [input.id, input.paused, fixedTime],
        );
      }
    },
    async installBootstrapFailure() {
      await pool.query(`
        create function operator_bootstrap_test_failure() returns trigger as $$
        begin
          if new.normalized_email = 'fail@example.test' then
            raise exception 'BOOTSTRAP_TEST_FAILURE';
          end if;
          return new;
        end;
        $$ language plpgsql;
        create trigger operator_bootstrap_test_failure
        before insert on workspace_members
        for each row execute function operator_bootstrap_test_failure()
      `);
    },
    async invitations(workspaceId) {
      const result = await pool.query<StoredInvitation>(
        `select
           id,
           workspace_id as "workspaceId",
           kind,
           normalized_email as "normalizedEmail",
           target_role as "targetRole",
           member_id as "memberId",
           token_digest as "tokenDigest",
           created_by_member_id as "createdByMemberId",
           created_at as "createdAt",
           expires_at as "expiresAt",
           accepted_at as "acceptedAt",
           revoked_at as "revokedAt"
         from member_invitations where workspace_id = $1 order by created_at, id`,
        [workspaceId],
      );
      return result.rows;
    },
    async member(workspaceId) {
      const result = await pool.query<StoredMember>(
        `select
           id,
           workspace_id as "workspaceId",
           normalized_email as "normalizedEmail",
           display_name as "displayName",
           role,
           status,
           password_salt as "passwordSalt",
           password_digest as "passwordDigest",
           password_iterations as "passwordIterations",
           created_by_member_id as "createdByMemberId"
         from workspace_members where workspace_id = $1 order by id limit 1`,
        [workspaceId],
      );
      return result.rows[0] ?? null;
    },
    async removeBootstrapFailure() {
      await pool.query("drop trigger operator_bootstrap_test_failure on workspace_members");
      await pool.query("drop function operator_bootstrap_test_failure()");
    },
    repository: createPostgresOperatorIdentityRepository(database),
    async sessionRevoked() {
      const result = await pool.query<{ revokedAt: Date | null }>(
        'select revoked_at as "revokedAt" from admin_sessions where id = $1',
        ["S".repeat(43)],
      );
      return result.rows[0]?.revokedAt !== null;
    },
  };
}

function deterministicRandom(start = 0) {
  let counter = start;
  return (length: number) => {
    counter += 1;
    return new Uint8Array(length).fill(counter);
  };
}

test("operator command parsing requires an artifact and explicit Cloudflare location", () => {
  assert.equal(
    parseOperatorIdentityCommand([
      "reset",
      "--target",
      "cloudflare",
      "--workspace",
      "demo",
      "--member",
      "admin@example.test",
      "--site-url",
      "https://demo.opas.dev",
      "--output-file",
      "reset.txt",
      "--remote",
    ]).action,
    "reset",
  );
  for (const args of [
    ["reset", "--target", "cloudflare", "--workspace", "demo", "--member", "admin@example.test", "--site-url", "https://demo.opas.dev", "--output-file", "-", "--remote"],
    ["invite", "--target", "cloudflare", "--workspace", "demo", "--email", "new@example.test", "--site-url", "https://demo.opas.dev", "--remote"],
    ["bootstrap", "--target", "cloudflare", "--workspace", "demo", "--display-name", "Admin"],
    ["bootstrap", "--target", "postgres", "--workspace", "demo", "--display-name", "Admin", "--create-workspace-id", "workspace_demo"],
  ]) {
    assert.throws(() => parseOperatorIdentityCommand(args), /OPERATOR_IDENTITY_COMMAND_INVALID/u);
  }
});

test("bootstrap consumes environment credentials, enforces password boundaries, and returns no secret", async () => {
  const records: OperatorBootstrapRecord[] = [];
  const repository: OperatorIdentityRepository = {
    async bootstrap(request) {
      records.push(request);
      return {
        memberId: request.memberId,
        outcome: "created",
        workspaceCreated: false,
        workspaceId: "workspace_demo",
      };
    },
    async issueRecovery() {
      return { outcome: "not_found" };
    },
    async revokeUndeliveredRecovery() {},
  };
  const command = parseOperatorIdentityCommand([
    "bootstrap",
    "--target",
    "postgres",
    "--workspace",
    "demo",
    "--display-name",
    "Ada Admin",
  ]);

  await assert.rejects(
    runOperatorIdentityCommand(command, repository, {
      ADMIN_EMAIL: "admin@example.test",
      ADMIN_PASSWORD: "x".repeat(14),
    }),
    /PASSWORD_TOO_SHORT/u,
  );
  for (const password of ["🔐".repeat(15), "x".repeat(128)]) {
    const result = await runOperatorIdentityCommand(
      command,
      repository,
      { ADMIN_EMAIL: "Admin@Example.Test", ADMIN_PASSWORD: password },
    );
    assert.equal(JSON.stringify(result).includes(password), false);
  }
  assert.equal(records.length, 2);
  assert.equal(records.every((record) => record.normalizedEmail === "admin@example.test"), true);
  assert.equal(records.every((record) => record.password.iterations === 600_000), true);
  assert.equal(await verifyMemberPassword("🔐".repeat(15), records[0]!.password), true);
  assert.equal(await verifyMemberPassword("x".repeat(128), records[1]!.password), true);
});

test("recovery writes one mode-0600 fragment artifact and exposes no bearer in its result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opas-operator-artifact-"));
  const outputFile = path.join(directory, "reset.txt");
  const records: OperatorRecoveryRecord[] = [];
  const repository: OperatorIdentityRepository = {
    async bootstrap() {
      return { outcome: "not_found" };
    },
    async issueRecovery(request) {
      records.push(request);
      return { outcome: "created", workspaceId: "workspace_demo" };
    },
    async revokeUndeliveredRecovery() {},
  };
  try {
    const artifact = await openRecoveryArtifact(outputFile);
    const result = await runOperatorIdentityCommand(
      {
        action: "reset",
        member: "member_admin",
        outputFile,
        siteOrigin: "https://demo.opas.dev",
        target: "postgres",
        workspaceReference: "demo",
      },
      repository,
      {},
      artifact,
    );
    const contents = await readFile(outputFile, "utf8");
    const url = new URL(contents.trim());
    const bearer = url.hash.slice(1);
    assert.equal(url.pathname, "/admin/accept/reset");
    assert.equal(url.search, "");
    assert.equal(bearer.length, 43);
    assert.equal(records[0]?.tokenDigest.length, 64);
    assert.equal(records[0]?.tokenDigest.includes(bearer), false);
    assert.equal(JSON.stringify(result).includes(bearer), false);
    assert.equal(JSON.stringify(result).includes("#"), false);
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
    await assert.rejects(openRecoveryArtifact(outputFile), /RECOVERY_ARTIFACT_UNAVAILABLE/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("recovery delivery failure reports only a stable code and collision retry never exposes a bearer", async () => {
  const random = deterministicRandom();
  let calls = 0;
  let revocations = 0;
  let attemptedBearer = "";
  const repository: OperatorIdentityRepository = {
    async bootstrap() {
      return { outcome: "not_found" };
    },
    async issueRecovery() {
      calls += 1;
      return calls === 1
        ? { outcome: "collision" }
        : { outcome: "created", workspaceId: "workspace_demo" };
    },
    async revokeUndeliveredRecovery() {
      revocations += 1;
    },
  };
  let caught: unknown;
  try {
    await issueOperatorRecovery(
      repository,
      {
        kind: "credential_reset",
        member: "member_admin",
        siteOrigin: "https://demo.opas.dev",
        workspaceReference: "demo",
      },
      async (artifact) => {
        attemptedBearer = new URL(artifact.url).hash.slice(1);
        throw new Error("simulated filesystem failure");
      },
      { clock: () => fixedTime, randomBytes: random },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof OperatorIdentityError);
  assert.equal(caught.code, "RECOVERY_DELIVERY_FAILED");
  assert.equal(calls, 2);
  assert.equal(revocations, 1);
  assert.equal(String(caught).includes(attemptedBearer), false);
  assert.equal(caught.stack?.includes(attemptedBearer), false);
});

test("an unavailable recovery artifact prevents the database mutation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opas-operator-unavailable-"));
  const outputFile = path.join(directory, "occupied.txt");
  await writeFile(outputFile, "existing\n", { mode: 0o600 });
  let mutations = 0;
  const repository: OperatorIdentityRepository = {
    async bootstrap() {
      return { outcome: "not_found" };
    },
    async issueRecovery() {
      mutations += 1;
      return { outcome: "created", workspaceId: "workspace_demo" };
    },
    async revokeUndeliveredRecovery() {},
  };
  try {
    await assert.rejects(async () => {
      const artifact = await openRecoveryArtifact(outputFile);
      await runOperatorIdentityCommand(
        {
          action: "reset",
          member: "member_admin",
          outputFile,
          siteOrigin: "https://demo.opas.dev",
          target: "postgres",
          workspaceReference: "demo",
        },
        repository,
        {},
        artifact,
      );
    }, /RECOVERY_ARTIFACT_UNAVAILABLE/u);
    assert.equal(mutations, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("operator identity repository passes on local SQLite", async () => {
  await exerciseRepository(sqliteHarness(false));
});

test("operator identity repository passes through D1 atomic batches", async () => {
  await exerciseRepository(sqliteHarness(true));
});

test("empty migration, identity bootstrap, zero-row backfill, and resume form one clean install", async () => {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, { migrationsFolder: migrations.sqlite });
  try {
    const identity = createSqliteOperatorIdentityRepository(database);
    assert.deepEqual(
      await identity.bootstrap(
        bootstrapRecord("member_install", "install", {
          id: "workspace_install",
          name: "Install",
          slug: "install",
        }),
      ),
      {
        memberId: "member_install",
        outcome: "created",
        workspaceCreated: true,
        workspaceId: "workspace_install",
      },
    );
    const before = client.prepare(
      "select writes_paused as writesPaused from workspace_authoring_controls where workspace_id = ?",
    ).get("workspace_install") as { writesPaused: number };
    assert.equal(before.writesPaused, 1);

    const backfill = await runTeamAuthoringBackfill(
      createSqliteTeamAuthoringBackfillStore(client),
      { clock: () => fixedTime },
    );
    assert.equal(backfill.alreadyCompleted, false);
    assert.equal(backfill.articleCount, 0);
    assert.equal(backfill.completion[0]?.articleCount, 0);

    function readControl(): AuthoringControl {
      const row = client.prepare(
        `select
           controls.workspace_id as workspaceId,
           controls.writes_paused as writesPaused,
           controls.generation,
           controls.changed_by_member_id as changedByMemberId,
           controls.changed_at as changedAt,
           workspaces.slug as workspaceSlug,
           workspaces.name as workspaceName
         from workspace_authoring_controls controls
         inner join workspaces on workspaces.id = controls.workspace_id
         where controls.workspace_id = ?`,
      ).get("workspace_install") as Record<string, unknown>;
      return {
        changedAt: new Date(Number(row.changedAt)).toISOString(),
        changedByMemberId: row.changedByMemberId as string | null,
        generation: Number(row.generation),
        workspaceId: String(row.workspaceId),
        workspaceName: String(row.workspaceName),
        workspaceSlug: String(row.workspaceSlug),
        writesPaused: Number(row.writesPaused) === 1,
      };
    }

    const controlStore: AuthoringControlStore = {
      async backfillState(workspaceId) {
        const row = client.prepare(
          "select count(*) as count from workspace_authoring_migrations where workspace_id = ? and version = 1",
        ).get(workspaceId) as { count: number };
        return row.count === 1 ? "complete" : "incomplete";
      },
      async change(workspaceId, expectedGeneration, writesPaused, changedAt) {
        const changed = client.prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = generation + 1,
               changed_by_member_id = null, changed_at = ?
           where workspace_id = ? and generation = ?`,
        ).run(
          writesPaused ? 1 : 0,
          changedAt.getTime(),
          workspaceId,
          expectedGeneration,
        );
        return changed.changes === 1 ? readControl() : null;
      },
      async close() {},
      async find(workspace) {
        return workspace === "workspace_install" || workspace === "install"
          ? [readControl()]
          : [];
      },
    };
    const resumed = await runAuthoringControlCommand(
      {
        action: "resume",
        expectedGeneration: 0,
        target: "postgres",
        workspace: "install",
      },
      controlStore,
      () => new Date(fixedTime.getTime() + 1_000),
    );
    assert.equal(resumed.changed, true);
    assert.equal(resumed.control.writesPaused, false);
    assert.equal(resumed.control.generation, 1);
  } finally {
    client.close();
  }
});

test(
  "operator identity repository passes on Postgres",
  { timeout: 120_000 },
  async () => {
    await exerciseRepository(await postgresHarness());
  },
);
