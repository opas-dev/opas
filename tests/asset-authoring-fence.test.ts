// ABOUTME: Verifies authenticated asset lifecycle operations keep authorization and the authoring fence in one batch.
// ABOUTME: Confirms cleanup retains revision-held assets and paused D1 batches cannot leave partial mutations.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/d1";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { AuthoringPausedError } from "@/db/authoring-controls";
import { createPostgresRepository } from "@/db/postgres/repository";
import type { AssetAuthoringRequest, Repository } from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import { createSqliteRepository } from "@/db/sqlite/repository";
import * as schema from "@/db/schema/sqlite";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const checkedAt = new Date("2026-09-03T12:00:00.000Z");
const workspaceId = "workspace_assets";
const ownerMemberId = "member_asset_owner";
const memberId = "member_asset_editor";
const sessionId = "S".repeat(43);
const actor: AssetAuthoringRequest = {
  checkedAt,
  memberId,
  sessionId,
  workspaceId,
};

type AssetHarness = {
  name: string;
  repository: Repository;
  assetCount(): Promise<number>;
  manifestCount(): Promise<number>;
  pauseAuthoring(paused: boolean): Promise<void>;
  revokeSession(revoked: boolean): Promise<void>;
  setMemberStatus(status: "active" | "disabled"): Promise<void>;
  close(): Promise<void>;
};

function png(marker: number) {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    marker,
  ]);
}

async function exerciseAssetAuthoring(harness: AssetHarness) {
  const firstManifest = await harness.repository.createAuthorizedAssetManifest(
    actor,
    new Date(checkedAt.getTime() + 60_000),
  );
  const retainedAsset = await harness.repository.stageAuthorizedAsset(
    actor,
    firstManifest.id,
    { mediaType: "image/png", content: png(1) },
  );
  const orphanAsset = await harness.repository.stageAuthorizedAsset(
    actor,
    firstManifest.id,
    { mediaType: "image/png", content: png(2) },
  );
  assert.notEqual(retainedAsset.hash, orphanAsset.hash);

  const created = await harness.repository.createDraftArticle({
    actor,
    article: {
      id: "article_asset_retention",
      workspaceId,
      categoryId: "category_assets",
      slug: "asset-retention",
      title: "Asset retention",
      mdx: `# Asset retention\n\n![Retained](/api/assets/${retainedAsset.hash})`,
      isFaq: false,
      authorName: "Asset editor",
      position: 0,
    },
    assets: { manifestId: firstManifest.id, hashes: [retainedAsset.hash] },
    changeKind: "manual",
  });
  assert.equal(created.status, "saved", `${harness.name} created the private revision`);
  assert.equal(await harness.assetCount(), 1, `${harness.name} retained only the revision asset`);
  assert.ok(await harness.repository.getAsset(workspaceId, retainedAsset.hash));
  assert.equal(await harness.repository.getAsset(workspaceId, orphanAsset.hash), null);

  const expiringManifest = await harness.repository.createAuthorizedAssetManifest(
    actor,
    new Date(checkedAt.getTime() + 10),
  );
  const expiringAsset = await harness.repository.stageAuthorizedAsset(
    actor,
    expiringManifest.id,
    { mediaType: "image/png", content: png(3) },
  );
  await harness.repository.cleanupAuthorizedExpiredAssets({
    ...actor,
    checkedAt: new Date(checkedAt.getTime() + 11),
  });
  assert.equal(await harness.repository.getAsset(workspaceId, expiringAsset.hash), null);
  assert.ok(
    await harness.repository.getAsset(workspaceId, retainedAsset.hash),
    `${harness.name} deleted an immutable revision asset during cleanup`,
  );

  const beforeInvalidStage = await harness.assetCount();
  await assert.rejects(
    harness.repository.stageAuthorizedAsset(actor, "manifest_missing", {
      mediaType: "image/png",
      content: png(4),
    }),
  );
  assert.equal(
    await harness.assetCount(),
    beforeInvalidStage,
    `${harness.name} committed an asset without a valid manifest`,
  );

  const protectedManifest = await harness.repository.createAuthorizedAssetManifest(
    actor,
    new Date(checkedAt.getTime() + 60_000),
  );
  const beforePause = {
    assets: await harness.assetCount(),
    manifests: await harness.manifestCount(),
  };
  await harness.pauseAuthoring(true);
  for (const operation of [
    () =>
      harness.repository.createAuthorizedAssetManifest(
        actor,
        new Date(checkedAt.getTime() + 60_000),
      ),
    () =>
      harness.repository.stageAuthorizedAsset(actor, protectedManifest.id, {
        mediaType: "image/png",
        content: png(5),
      }),
    () => harness.repository.discardAuthorizedAssetManifest(actor, protectedManifest.id),
    () => harness.repository.cleanupAuthorizedExpiredAssets(actor),
  ]) {
    await assert.rejects(operation, AuthoringPausedError);
  }
  assert.deepEqual(
    {
      assets: await harness.assetCount(),
      manifests: await harness.manifestCount(),
    },
    beforePause,
    `${harness.name} changed asset state while authoring was paused`,
  );
  await harness.pauseAuthoring(false);

  await harness.setMemberStatus("disabled");
  await assert.rejects(() =>
    harness.repository.discardAuthorizedAssetManifest(actor, protectedManifest.id),
  );
  assert.equal(await harness.manifestCount(), beforePause.manifests);
  await harness.setMemberStatus("active");

  await harness.revokeSession(true);
  await assert.rejects(() =>
    harness.repository.discardAuthorizedAssetManifest(actor, protectedManifest.id),
  );
  assert.equal(await harness.manifestCount(), beforePause.manifests);
  await harness.revokeSession(false);

  await harness.repository.discardAuthorizedAssetManifest(actor, protectedManifest.id);
  assert.equal(await harness.manifestCount(), 0);
  assert.ok(await harness.repository.getAsset(workspaceId, retainedAsset.hash));
}

async function createPostgresHarness(): Promise<AssetHarness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  try {
    await migratePostgres(database, { migrationsFolder: migrations.postgres });
    await pool.query(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values ($1, 'asset-tests', 'Asset tests', $2, $2)`,
      [workspaceId, checkedAt],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_at, updated_at
       ) values ($1, $2, 'owner@asset.test', 'Owner', 'administrator', 'active',
                 $3, $4, 600000, $5, $5)`,
      [ownerMemberId, workspaceId, "A".repeat(43), "B".repeat(43), checkedAt],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values ($1, $2, 'editor@asset.test', 'Editor', 'editor', 'active',
                 $3, $4, 600000, $5, $6, $6)`,
      [memberId, workspaceId, "C".repeat(43), "D".repeat(43), ownerMemberId, checkedAt],
    );
    await pool.query(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [sessionId, workspaceId, memberId, checkedAt, new Date(checkedAt.getTime() + 28_800_000)],
    );
    await pool.query(
      `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
       values ('category_assets', $1, 'assets', 'Assets', 0, $2, $2)`,
      [workspaceId, checkedAt],
    );
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }

  return {
    name: "Postgres",
    repository: createPostgresRepository(database),
    async assetCount() {
      return Number(
        (await pool.query("select count(*)::integer as count from assets where workspace_id = $1", [workspaceId]))
          .rows[0]?.count ?? 0,
      );
    },
    async manifestCount() {
      return Number(
        (await pool.query("select count(*)::integer as count from asset_manifests where workspace_id = $1", [workspaceId]))
          .rows[0]?.count ?? 0,
      );
    },
    async pauseAuthoring(paused) {
      await pool.query(
        `update workspace_authoring_controls
         set writes_paused = $1, generation = generation + 1, changed_at = $2
         where workspace_id = $3`,
        [paused, checkedAt, workspaceId],
      );
    },
    async revokeSession(revoked) {
      await pool.query(
        "update admin_sessions set revoked_at = $1 where workspace_id = $2 and id = $3",
        [revoked ? checkedAt : null, workspaceId, sessionId],
      );
    },
    async setMemberStatus(status) {
      await pool.query(
        "update workspace_members set status = $1, updated_at = $2 where workspace_id = $3 and id = $4",
        [status, checkedAt, workspaceId, memberId],
      );
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

async function createSqliteHarness(): Promise<AssetHarness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema });
  try {
    migrateSqlite(database, { migrationsFolder: migrations.sqlite });
    client
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'asset-tests', 'Asset tests', ?, ?)`,
      )
      .run(workspaceId, checkedAt.getTime(), checkedAt.getTime());
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'owner@asset.test', 'Owner', 'administrator', 'active',
                   ?, ?, 600000, ?, ?)`,
      )
      .run(
        ownerMemberId,
        workspaceId,
        "A".repeat(43),
        "B".repeat(43),
        checkedAt.getTime(),
        checkedAt.getTime(),
      );
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@asset.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .run(
        memberId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        ownerMemberId,
        checkedAt.getTime(),
        checkedAt.getTime(),
      );
    client
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        workspaceId,
        memberId,
        checkedAt.getTime(),
        checkedAt.getTime() + 28_800_000,
      );
    client
      .prepare(
        `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
         values ('category_assets', ?, 'assets', 'Assets', 0, ?, ?)`,
      )
      .run(workspaceId, checkedAt.getTime(), checkedAt.getTime());
  } catch (error) {
    client.close();
    throw error;
  }

  return {
    name: "SQLite",
    repository: createSqliteRepository(database),
    async assetCount() {
      const row = client
        .prepare("select count(*) as count from assets where workspace_id = ?")
        .get(workspaceId) as { count: number };
      return Number(row.count);
    },
    async manifestCount() {
      const row = client
        .prepare("select count(*) as count from asset_manifests where workspace_id = ?")
        .get(workspaceId) as { count: number };
      return Number(row.count);
    },
    async pauseAuthoring(paused) {
      client
        .prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = generation + 1, changed_at = ?
           where workspace_id = ?`,
        )
        .run(paused ? 1 : 0, checkedAt.getTime(), workspaceId);
    },
    async revokeSession(revoked) {
      client
        .prepare(
          "update admin_sessions set revoked_at = ? where workspace_id = ? and id = ?",
        )
        .run(revoked ? checkedAt.getTime() : null, workspaceId, sessionId);
    },
    async setMemberStatus(status) {
      client
        .prepare(
          "update workspace_members set status = ?, updated_at = ? where workspace_id = ? and id = ?",
        )
        .run(status, checkedAt.getTime(), workspaceId, memberId);
    },
    async close() {
      client.close();
    },
  };
}

test("admin asset route threads the authorized named-member session through every mutation", async () => {
  const source = await readFile(new URL("../src/app/admin/content/assets/route.ts", import.meta.url), "utf8");
  assert.match(source, /const member = await requireMemberCapability\("draft:edit"/u);
  for (const operation of [
    "cleanupAuthorizedExpiredAssets",
    "createAuthorizedAssetManifest",
    "stageAuthorizedAsset",
    "discardAuthorizedAssetManifest",
  ]) assert.match(source, new RegExp(operation, "u"));
  assert.match(source, /sessionId: member\.sessionId/u);
});

test("D1 asset cleanup batches fence and actor assertions before mutations", async () => {
  type Statement = { sql: string; parameters: unknown[] };
  const batches: Statement[][] = [];
  const client = {
    prepare(sql: string) {
      return { bind: (...parameters: unknown[]) => ({ sql, parameters }) };
    },
    async batch(statements: Statement[]) {
      batches.push(statements);
      throw new Error("AUTHORING_PAUSED");
    },
  };
  const repository = createSqliteRepository(drizzle(client as never, { schema }));
  await assert.rejects(
    repository.cleanupAuthorizedExpiredAssets(
      {
        checkedAt: new Date("2026-09-03T12:00:00.000Z"),
        memberId: "editor_one",
        sessionId: "session_one",
        workspaceId: "workspace_one",
      },
    ),
    /AUTHORING_PAUSED/u,
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 4);
  assert.match(batches[0]?.[0]?.sql ?? "", /workspace_authoring_assertions/u);
  assert.match(batches[0]?.[1]?.sql ?? "", /workspace_members[\s\S]*admin_sessions/u);
  assert.match(batches[0]?.[2]?.sql ?? "", /delete from asset_manifests/u);
  assert.match(batches[0]?.[3]?.sql ?? "", /article_revision_assets/u);
});

test("both dialects retain assets referenced by immutable revisions", async () => {
  const [postgres, sqlite] = await Promise.all([
    readFile(new URL("../src/db/postgres/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/db/sqlite/repository.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [postgres, sqlite]) {
    assert.match(source, /not exists \(\s*select 1 from article_revision_assets/u);
    assert.match(source, /authoringAssertion\(request\.workspaceId/u);
    assert.match(source, /assetActorAssertion\(request\)/u);
  }
});

test("real Postgres and SQLite asset writes recheck the fence and named actor atomically", async () => {
  for (const createHarness of [createPostgresHarness, createSqliteHarness]) {
    const harness = await createHarness();
    try {
      await exerciseAssetAuthoring(harness);
    } finally {
      await harness.close();
    }
  }
});
