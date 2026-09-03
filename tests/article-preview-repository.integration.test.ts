// ABOUTME: Exercises signed preview rotation and reads against real PostgreSQL and SQLite stores.
// ABOUTME: Verifies serialization, paused revocation, immutable revision assets, and live rechecks.

import assert from "node:assert/strict";
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
  issueArticlePreview,
  resolveArticlePreview,
  resolveArticlePreviewAsset,
  revokeArticlePreview,
  type ArticlePreviewRepository,
} from "@/auth/article-preview";
import { AuthoringPausedError } from "@/db/authoring-controls";
import { createPostgresArticlePreviewRepository } from "@/db/postgres/article-preview-repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteArticlePreviewRepository } from "@/db/sqlite/article-preview-repository";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const startedAt = new Date("2026-09-03T12:00:00.000Z");
const workspaceId = "workspace_preview";
const administratorId = "member_preview_admin";
const creatorId = "member_preview_editor";
const sessionId = "S".repeat(43);
const articleId = "article_preview";
const revisionId = "revision_preview_4";
const assetId = "asset_preview";
const assetHash = "a".repeat(64);
const configuration = Object.freeze({
  deploymentId: "preview.example.test",
  signingSecret: "repository-preview-signing-secret-at-least-32-bytes",
});
const actor = Object.freeze({ memberId: creatorId, sessionId, workspaceId });

type Harness = Readonly<{
  activeGrantIds(): Promise<readonly string[]>;
  archive(): Promise<void>;
  close(): Promise<void>;
  disableCreator(): Promise<void>;
  grantRows(): Promise<readonly Record<string, unknown>[]>;
  pause(paused: boolean): Promise<void>;
  repository: ArticlePreviewRepository;
}>;

function fixedBytes(offset: number) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

async function issue(
  repository: ArticlePreviewRepository,
  issuedAt: Date,
  randomOffset: number,
) {
  return issueArticlePreview(actor, revisionId, configuration, {
    clock: () => issuedAt,
    randomBytes: fixedBytes(randomOffset),
    repository,
  });
}

async function exerciseRepository(name: string, harness: Harness) {
  const first = await issue(harness.repository, startedAt, 1);
  assert.equal(first.outcome, "issued", `${name} issued the first grant`);
  if (first.outcome !== "issued") return;

  const exhausted = await issue(
    harness.repository,
    new Date(startedAt.getTime() + 1_000),
    1,
  );
  assert.deepEqual(exhausted, {
    outcome: "rejected",
    code: "GRANT_ID_COLLISION_EXHAUSTED",
  });
  assert.deepEqual(await harness.activeGrantIds(), [first.grantId]);
  assert.ok(
    await resolveArticlePreview(first.token, configuration, {
      clock: () => new Date(startedAt.getTime() + 1_500),
      repository: harness.repository,
    }),
  );

  const rotationTime = new Date(startedAt.getTime() + 2_000);
  const rotated = await Promise.all([
    issue(harness.repository, rotationTime, 2),
    issue(harness.repository, rotationTime, 3),
  ]);
  assert.equal(
    rotated.filter((result) => result.outcome === "issued").length,
    2,
    `${name} serialized both rotations`,
  );
  const activeIds = await harness.activeGrantIds();
  assert.equal(activeIds.length, 1);
  const resolved = await Promise.all(
    rotated.map((result) =>
      result.outcome === "issued"
        ? resolveArticlePreview(result.token, configuration, {
            clock: () => new Date(rotationTime.getTime() + 1_000),
            repository: harness.repository,
          })
        : null,
    ),
  );
  assert.equal(resolved.filter(Boolean).length, 1);
  const winnerIndex = resolved.findIndex(Boolean);
  const winner = rotated[winnerIndex];
  assert.equal(winner?.outcome, "issued");
  if (!winner || winner.outcome !== "issued") return;
  assert.equal(winner.grantId, activeIds[0]);
  assert.equal(resolved[winnerIndex]?.revisionId, revisionId);
  assert.deepEqual(resolved[winnerIndex]?.assetHashes, [assetHash]);
  assert.deepEqual(resolved[winnerIndex]?.remoteImageHosts, ["cdn.example.test"]);
  assert.match(
    resolved[winnerIndex]?.mdx ?? "",
    new RegExp(`/preview/assets/${assetHash}`, "u"),
  );

  const previewAsset = await resolveArticlePreviewAsset(
    winner.token,
    assetHash,
    configuration,
    {
      clock: () => new Date(rotationTime.getTime() + 1_000),
      repository: harness.repository,
    },
  );
  assert.equal(previewAsset?.hash, assetHash);
  assert.deepEqual(
    previewAsset?.content,
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(
    await resolveArticlePreviewAsset(
      winner.token,
      "b".repeat(64),
      configuration,
      {
        clock: () => new Date(rotationTime.getTime() + 1_000),
        repository: harness.repository,
      },
    ),
    null,
  );

  const serializedRows = JSON.stringify(await harness.grantRows());
  assert.equal(serializedRows.includes(winner.token), false);
  assert.equal(serializedRows.includes(encodeURIComponent(winner.token)), false);

  const concurrentRevocations = await Promise.all([
    revokeArticlePreview(actor, winner.grantId, {
      clock: () => new Date(rotationTime.getTime() + 1_500),
      repository: harness.repository,
    }),
    revokeArticlePreview(actor, winner.grantId, {
      clock: () => new Date(rotationTime.getTime() + 1_500),
      repository: harness.repository,
    }),
  ]);
  assert.equal(
    concurrentRevocations.filter(({ outcome }) => outcome === "revoked").length,
    1,
  );
  assert.equal(
    concurrentRevocations.filter(({ outcome }) => outcome === "rejected").length,
    1,
  );

  const pausedTarget = await issue(
    harness.repository,
    new Date(rotationTime.getTime() + 1_750),
    6,
  );
  assert.equal(pausedTarget.outcome, "issued");
  if (pausedTarget.outcome !== "issued") return;

  await harness.pause(true);
  await assert.rejects(
    issue(harness.repository, new Date(rotationTime.getTime() + 2_000), 4),
    AuthoringPausedError,
  );
  assert.deepEqual(
    await revokeArticlePreview(actor, pausedTarget.grantId, {
      clock: () => new Date(rotationTime.getTime() + 3_000),
      repository: harness.repository,
    }),
    { outcome: "revoked" },
  );
  assert.equal((await harness.activeGrantIds()).length, 0);
  await harness.pause(false);

  const archived = await issue(
    harness.repository,
    new Date(rotationTime.getTime() + 4_000),
    5,
  );
  assert.equal(archived.outcome, "issued");
  if (archived.outcome !== "issued") return;
  await harness.archive();
  assert.equal(
    await resolveArticlePreview(archived.token, configuration, {
      clock: () => new Date(rotationTime.getTime() + 5_000),
      repository: harness.repository,
    }),
    null,
  );
  assert.equal(
    await resolveArticlePreviewAsset(
      archived.token,
      assetHash,
      configuration,
      {
        clock: () => new Date(rotationTime.getTime() + 5_000),
        repository: harness.repository,
      },
    ),
    null,
  );

  await harness.disableCreator();
  assert.equal(
    await harness.repository.findActiveGrant({
      checkedAt: new Date(rotationTime.getTime() + 6_000),
      grantId: archived.grantId,
      revisionId,
      workspaceId,
    }),
    null,
  );
}

function seedSqlite(client: Database.Database) {
  const timestamp = startedAt.getTime();
  client
    .prepare(
      "insert into workspaces (id, slug, name, created_at, updated_at) values (?, 'preview', 'Preview', ?, ?)",
    )
    .run(workspaceId, timestamp, timestamp);
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_at, updated_at
       ) values (?, ?, 'admin@preview.test', 'Admin', 'administrator', 'active',
                 ?, ?, 600000, ?, ?)`
    )
    .run(administratorId, workspaceId, "A".repeat(43), "B".repeat(43), timestamp, timestamp);
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values (?, ?, 'editor@preview.test', 'Editor', 'editor', 'active',
                 ?, ?, 600000, ?, ?, ?)`
    )
    .run(
      creatorId,
      workspaceId,
      "C".repeat(43),
      "D".repeat(43),
      administratorId,
      timestamp,
      timestamp,
    );
  client
    .prepare(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values (?, ?, ?, ?, ?)`
    )
    .run(sessionId, workspaceId, creatorId, timestamp, timestamp + 60 * 60 * 1_000);
  client
    .prepare(
      `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
       values ('category_preview', ?, 'guides', 'Guides', 0, ?, ?)`
    )
    .run(workspaceId, timestamp, timestamp);
  client
    .prepare(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, status, is_faq,
         author_name, position, created_at, updated_at
       ) values (?, ?, 'category_preview', 'exact-preview', 'Exact preview', '# Exact preview',
                 'draft', 0, 'Editor', 4, ?, ?)`
    )
    .run(articleId, workspaceId, timestamp, timestamp);
  client
    .prepare(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id,
         category_slug, category_name, slug, title, mdx, is_faq, author_name,
         position, revision_hash, change_kind, created_by_member_id, created_at
       ) values (?, ?, ?, 4, 'category_preview', 'guides', 'Guides', 'exact-preview',
                 'Exact preview', ?, 0, 'Editor', 4, ?, 'manual', ?, ?)`
    )
    .run(
      revisionId,
      workspaceId,
      articleId,
      `# Exact preview\n\n![Stored](/api/assets/${assetHash})\n\n![Remote](https://cdn.example.test/image.png)`,
      "e".repeat(64),
      creatorId,
      timestamp,
    );
  client
    .prepare(
      `insert into article_slug_claims (
         workspace_id, normalized_slug, article_id, working_claim, article_row_claim
       ) values (?, 'exact-preview', ?, 1, 1)`
    )
    .run(workspaceId, articleId);
  client
    .prepare(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, review_state
       ) values (?, ?, ?, 4, 'exact-preview', 'editing')`
    )
    .run(articleId, workspaceId, revisionId);
  client
    .prepare(
      `insert into assets (
         id, workspace_id, hash, media_type, byte_size, content, created_at
       ) values (?, ?, ?, 'image/png', 8, ?, ?)`
    )
    .run(
      assetId,
      workspaceId,
      assetHash,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      timestamp,
    );
  client
    .prepare(
      `insert into article_revision_assets (
         workspace_id, article_id, revision_id, revision_number, asset_id
       ) values (?, ?, ?, 4, ?)`
    )
    .run(workspaceId, articleId, revisionId, assetId);
}

async function sqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, { migrationsFolder: migrations.sqlite });
  seedSqlite(client);
  for (const statement of sqliteTeamAuthoringGuardStatements) client.exec(statement);
  return {
    async activeGrantIds() {
      return (
        client
          .prepare(
            "select id from article_preview_grants where workspace_id = ? and revoked_at is null order by id",
          )
          .all(workspaceId) as { id: string }[]
      ).map(({ id }) => id);
    },
    async archive() {
      client
        .prepare(
          `update article_heads set archived_at = ?, archived_by_member_id = ?
           where workspace_id = ? and article_id = ?`,
        )
        .run(startedAt.getTime() + 10_000, administratorId, workspaceId, articleId);
    },
    async close() {
      client.close();
    },
    async disableCreator() {
      client
        .prepare("update workspace_members set status = 'disabled' where id = ?")
        .run(creatorId);
    },
    async grantRows() {
      return client
        .prepare("select * from article_preview_grants order by id")
        .all() as Record<string, unknown>[];
    },
    async pause(paused) {
      client
        .prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = generation + 1, changed_at = ?
           where workspace_id = ?`,
        )
        .run(paused ? 1 : 0, startedAt.getTime() + 3_000, workspaceId);
    },
    repository: createSqliteArticlePreviewRepository(database),
  };
}

async function seedPostgres(pool: Pool) {
  await pool.query(
    "insert into workspaces (id, slug, name, created_at, updated_at) values ($1, 'preview', 'Preview', $2, $2)",
    [workspaceId, startedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_at, updated_at
     ) values ($1, $2, 'admin@preview.test', 'Admin', 'administrator', 'active',
               $3, $4, 600000, $5, $5)`,
    [administratorId, workspaceId, "A".repeat(43), "B".repeat(43), startedAt],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations,
       created_by_member_id, created_at, updated_at
     ) values ($1, $2, 'editor@preview.test', 'Editor', 'editor', 'active',
               $3, $4, 600000, $5, $6, $6)`,
    [
      creatorId,
      workspaceId,
      "C".repeat(43),
      "D".repeat(43),
      administratorId,
      startedAt,
    ],
  );
  await pool.query(
    `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [sessionId, workspaceId, creatorId, startedAt, new Date(startedAt.getTime() + 60 * 60 * 1_000)],
  );
  await pool.query(
    `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
     values ('category_preview', $1, 'guides', 'Guides', 0, $2, $2)`,
    [workspaceId, startedAt],
  );
  await pool.query(
    `insert into articles (
       id, workspace_id, category_id, slug, title, mdx, status, is_faq,
       author_name, position, created_at, updated_at
     ) values ($1, $2, 'category_preview', 'exact-preview', 'Exact preview', '# Exact preview',
               'draft', false, 'Editor', 4, $3, $3)`,
    [articleId, workspaceId, startedAt],
  );
  await pool.query(
    `insert into article_revisions (
       id, workspace_id, article_id, revision_number, category_id,
       category_slug, category_name, slug, title, mdx, is_faq, author_name,
       position, revision_hash, change_kind, created_by_member_id, created_at
     ) values ($1, $2, $3, 4, 'category_preview', 'guides', 'Guides', 'exact-preview',
               'Exact preview', $4, false, 'Editor', 4, $5, 'manual', $6, $7)`,
    [
      revisionId,
      workspaceId,
      articleId,
      `# Exact preview\n\n![Stored](/api/assets/${assetHash})\n\n![Remote](https://cdn.example.test/image.png)`,
      "e".repeat(64),
      creatorId,
      startedAt,
    ],
  );
  await pool.query(
    `insert into article_slug_claims (
       workspace_id, normalized_slug, article_id, working_claim, article_row_claim
     ) values ($1, 'exact-preview', $2, true, true)`,
    [workspaceId, articleId],
  );
  await pool.query(
    `insert into article_heads (
       article_id, workspace_id, working_revision_id, working_revision_number,
       working_slug, review_state
     ) values ($1, $2, $3, 4, 'exact-preview', 'editing')`,
    [articleId, workspaceId, revisionId],
  );
  await pool.query(
    `insert into assets (
       id, workspace_id, hash, media_type, byte_size, content, created_at
     ) values ($1, $2, $3, 'image/png', 8, $4, $5)`,
    [
      assetId,
      workspaceId,
      assetHash,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      startedAt,
    ],
  );
  await pool.query(
    `insert into article_revision_assets (
       workspace_id, article_id, revision_id, revision_number, asset_id
     ) values ($1, $2, $3, 4, $4)`,
    [workspaceId, articleId, revisionId, assetId],
  );
}

async function postgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  await migratePostgres(database, { migrationsFolder: migrations.postgres });
  await seedPostgres(pool);
  for (const statement of postgresTeamAuthoringGuardStatements) {
    await pool.query(statement);
  }
  return {
    async activeGrantIds() {
      const result = await pool.query<{ id: string }>(
        `select id from article_preview_grants
         where workspace_id = $1 and revoked_at is null order by id`,
        [workspaceId],
      );
      return result.rows.map(({ id }) => id);
    },
    async archive() {
      await pool.query(
        `update article_heads set archived_at = $1, archived_by_member_id = $2
         where workspace_id = $3 and article_id = $4`,
        [new Date(startedAt.getTime() + 10_000), administratorId, workspaceId, articleId],
      );
    },
    async close() {
      await pool.end();
      await container.stop();
    },
    async disableCreator() {
      await pool.query("update workspace_members set status = 'disabled' where id = $1", [
        creatorId,
      ]);
    },
    async grantRows() {
      return (await pool.query("select * from article_preview_grants order by id"))
        .rows as Record<string, unknown>[];
    },
    async pause(paused) {
      await pool.query(
        `update workspace_authoring_controls
         set writes_paused = $1, generation = generation + 1, changed_at = $2
         where workspace_id = $3`,
        [paused, new Date(startedAt.getTime() + 3_000), workspaceId],
      );
    },
    repository: createPostgresArticlePreviewRepository(database),
  };
}

for (const [name, createHarness] of [
  ["sqlite", sqliteHarness],
  ["postgres", postgresHarness],
] as const) {
  test(
    `${name} preview repository keeps one exact live grant`,
    { timeout: name === "postgres" ? 120_000 : 30_000 },
    async () => {
      const harness = await createHarness();
      try {
        await exerciseRepository(name, harness);
      } finally {
        await harness.close();
      }
    },
  );
}
