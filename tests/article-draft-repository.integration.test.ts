// ABOUTME: Verifies immutable private draft saves across real Postgres and SQLite semantics.
// ABOUTME: Exercises optimistic races, authorization, slug ownership, assets, and public isolation.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

import { articleRevisionHash } from "@/content/article-revision";
import { AuthoringPausedError } from "@/db/authoring-controls";
import type {
  ArticleDraftRepository,
  CreateDraftArticleRequest,
  DraftArticleValues,
  DraftWriteResult,
  SaveDraftArticleRequest,
} from "@/db/article-drafts";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import { postgresTeamAuthoringGuardStatements } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteArticleDraftRepository } from "@/db/sqlite/article-draft-repository";
import { sqliteTeamAuthoringGuardStatements } from "@/db/sqlite/team-authoring-backfill";

const migrations = {
  postgres: path.join(process.cwd(), "drizzle/postgres"),
  sqlite: path.join(process.cwd(), "drizzle/sqlite"),
};
const now = new Date("2026-09-03T12:00:00.000Z");
const later = new Date(now.getTime() + 60 * 60 * 1000);
const workspaceId = "workspace_drafts";
const ownerMemberId = "member_owner";
const memberId = "member_editor";
const sessionId = "S".repeat(43);
const categoryId = "category_guides";
const publicArticleId = "article_public";
const publicAssetHash = "a".repeat(64);
const draftAssetHash = "b".repeat(64);

type Inventory = {
  articleAssets: readonly unknown[];
  articles: readonly unknown[];
  evidenceChunks: readonly unknown[];
  indexingState: readonly unknown[];
};

type Harness = {
  name: string;
  repository: ArticleDraftRepository;
  repositoryForRevisionId(id: string): ArticleDraftRepository;
  addManifest(id: string, hashes: readonly string[]): Promise<void>;
  disableActor(): Promise<void>;
  enableActor(): Promise<void>;
  inventory(): Promise<Inventory>;
  pauseAuthoring(paused: boolean): Promise<void>;
  revokeActorSession(): Promise<void>;
  setActorRole(role: "editor" | "reviewer"): Promise<void>;
  query<T extends object>(postgres: string, sqlite: string, values?: readonly unknown[]): Promise<T[]>;
  revisionCount(articleId: string): Promise<number>;
  close(): Promise<void>;
  lockAndDisableActor?: () => Promise<() => Promise<void>>;
};

function article(id: string, slug: string, title = "Draft title"): DraftArticleValues {
  return {
    id,
    workspaceId,
    categoryId,
    slug,
    title,
    mdx: `# ${title}\n\nPrivate body.`,
    isFaq: false,
    authorName: "Editor",
    position: 1,
  };
}

function createRequest(
  values: DraftArticleValues,
  hashes: readonly string[] = [],
  manifestId?: string,
): CreateDraftArticleRequest {
  return {
    actor: { memberId, sessionId },
    article: values,
    assets: { hashes, ...(manifestId ? { manifestId } : {}) },
    changeKind: "manual",
  };
}

function saveRequest(
  values: DraftArticleValues,
  expectedWorkingRevisionNumber: number,
  hashes: readonly string[] = [],
  manifestId?: string,
): SaveDraftArticleRequest {
  return {
    ...createRequest(values, hashes, manifestId),
    expectedWorkingRevisionNumber,
  };
}

function outcomeCount(results: readonly DraftWriteResult[], status: DraftWriteResult["status"]) {
  return results.filter((result) => result.status === status).length;
}

async function completeArticleState(harness: Harness) {
  const tables = [
    "articles",
    "article_assets",
    "article_heads",
    "article_revisions",
    "article_revision_assets",
    "article_slug_claims",
    "asset_manifests",
    "asset_manifest_items",
    "assets",
    "evidence_chunks",
    "workspace_index_states",
  ] as const;
  const entries = await Promise.all(
    tables.map(async (table) => [
      table,
      await harness.query<Record<string, unknown>>(
        `select * from ${table} where workspace_id = $1 order by 1, 2`,
        `select * from ${table} where workspace_id = ? order by 1, 2`,
        [workspaceId],
      ),
    ] as const),
  );
  return Object.fromEntries(entries);
}

async function publicBaselineRevisionHash() {
  return articleRevisionHash({
    workspaceId,
    articleId: publicArticleId,
    categoryId,
    categorySlug: "guides",
    categoryName: "Guides",
    slug: "public-guide",
    title: "Public guide",
    mdx: "# Public guide\n\nPublic body.",
    isFaq: true,
    authorName: "OPAS",
    position: 0,
    assetHashes: [publicAssetHash],
  });
}

async function exerciseRepository(harness: Harness) {
  const beforePublic = await harness.inventory();
  await harness.addManifest("manifest_concurrent", [draftAssetHash]);
  const simultaneous = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      harness.repository.saveDraftArticle(
        saveRequest(
          {
            ...article(publicArticleId, "private-guide", `Private edit ${index}`),
            mdx: `# Private edit ${index}\n\nConcurrent private body.`,
          },
          1,
          [publicAssetHash, draftAssetHash],
          "manifest_concurrent",
        ),
      ),
    ),
  );
  assert.equal(outcomeCount(simultaneous, "saved"), 1, `${harness.name} accepted one save`);
  assert.equal(outcomeCount(simultaneous, "conflict"), 11, `${harness.name} rejected stale saves`);
  for (const result of simultaneous) {
    if (result.status === "conflict") {
      assert.equal(result.code, "STALE_REVISION");
      assert.equal(result.currentRevisionNumber, 2);
    }
  }

  const winningTitle = (
    simultaneous.find((result) => result.status === "saved") as Extract<
      DraftWriteResult,
      { status: "saved" }
    >
  ).revisionId;
  assert.match(winningTitle, /^revision_/u);
  assert.equal(await harness.revisionCount(publicArticleId), 2);
  assert.deepEqual(await harness.inventory(), beforePublic, `${harness.name} kept public state exact`);

  const [working] = await harness.query<{
    mdx: string;
    revision_number: number;
    title: string;
  }>(
    `select revision.mdx, revision.revision_number, revision.title
     from article_heads head
     inner join article_revisions revision on revision.id = head.working_revision_id
     where head.workspace_id = $1 and head.article_id = $2`,
    `select revision.mdx, revision.revision_number, revision.title
     from article_heads head
     inner join article_revisions revision on revision.id = head.working_revision_id
     where head.workspace_id = ? and head.article_id = ?`,
    [workspaceId, publicArticleId],
  );
  assert.equal(working.revision_number, 2);

  const second = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...article(publicArticleId, "private-guide", "Second private save"),
        mdx: "# Second private save\n\nOnly the newer image remains.",
      },
      2,
      [draftAssetHash],
    ),
  );
  assert.equal(second.status, "saved");
  if (second.status !== "saved") throw new Error("Second save did not persist");
  assert.equal(second.revisionNumber, 3);
  assert.deepEqual(await harness.inventory(), beforePublic);

  await harness.addManifest("manifest_noop", [draftAssetHash]);
  const beforeUnchanged = await completeArticleState(harness);
  const unchanged = await harness.repository.saveDraftArticle(
    saveRequest(
      {
        ...article(publicArticleId, "private-guide", "Second private save"),
        mdx: "# Second private save\n\nOnly the newer image remains.",
      },
      3,
      [draftAssetHash],
      "manifest_noop",
    ),
  );
  assert.deepEqual(unchanged, {
    status: "unchanged",
    articleId: publicArticleId,
    revisionId: second.revisionId,
    revisionNumber: 3,
  });
  assert.equal(await harness.revisionCount(publicArticleId), 3);
  assert.deepEqual(await completeArticleState(harness), beforeUnchanged);

  const retained = await harness.query<{ hash: string; revision_number: number }>(
    `select asset.hash, revision_asset.revision_number
     from article_revision_assets revision_asset
     inner join assets asset on asset.id = revision_asset.asset_id
     where revision_asset.workspace_id = $1 and revision_asset.article_id = $2
     order by revision_asset.revision_number, asset.hash`,
    `select asset.hash, revision_asset.revision_number
     from article_revision_assets revision_asset
     inner join assets asset on asset.id = revision_asset.asset_id
     where revision_asset.workspace_id = ? and revision_asset.article_id = ?
     order by revision_asset.revision_number, asset.hash`,
    [workspaceId, publicArticleId],
  );
  assert.deepEqual(retained, [
    { hash: publicAssetHash, revision_number: 1 },
    { hash: publicAssetHash, revision_number: 2 },
    { hash: draftAssetHash, revision_number: 2 },
    { hash: draftAssetHash, revision_number: 3 },
  ]);

  await harness.addManifest("manifest_rejected", [draftAssetHash]);
  const beforeRejected = await completeArticleState(harness);
  const rejectedAsset = await harness.repository.saveDraftArticle(
    saveRequest(
      article(publicArticleId, "private-guide", "Missing asset"),
      3,
      ["f".repeat(64)],
      "manifest_rejected",
    ),
  );
  assert.deepEqual(rejectedAsset, { status: "rejected", code: "ASSET_UNAVAILABLE" });
  assert.deepEqual(await completeArticleState(harness), beforeRejected);
  assert.deepEqual(await harness.inventory(), beforePublic);

  await harness.addManifest("manifest_failed", [draftAssetHash]);
  const beforeFailed = await completeArticleState(harness);
  await assert.rejects(
    harness.repositoryForRevisionId("revision_public_1").saveDraftArticle(
      saveRequest(
        article(publicArticleId, "failed-private", "Failed write"),
        3,
        [draftAssetHash],
        "manifest_failed",
      ),
    ),
  );
  assert.deepEqual(await completeArticleState(harness), beforeFailed);

  const beforeInvalidRevision = await completeArticleState(harness);
  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Invalid token"), 0),
    ),
    { status: "rejected", code: "INVALID_REVISION_NUMBER" },
  );
  assert.deepEqual(await completeArticleState(harness), beforeInvalidRevision);

  const beforePaused = await completeArticleState(harness);
  await harness.pauseAuthoring(true);
  await assert.rejects(
    harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Paused edit"), 3, [draftAssetHash]),
    ),
    AuthoringPausedError,
  );
  await harness.pauseAuthoring(false);
  assert.deepEqual(await completeArticleState(harness), beforePaused);

  const draft = article("article_rename", "old-draft", "Rename me");
  assert.equal((await harness.repository.createDraftArticle(createRequest(draft))).status, "saved");
  const renamed = await harness.repository.saveDraftArticle(
    saveRequest({ ...draft, slug: "renamed-draft", title: "Renamed" }, 1),
  );
  assert.equal(renamed.status, "saved");
  const reused = await harness.repository.createDraftArticle(
    createRequest(article("article_reused", "old-draft", "Old slug reused")),
  );
  assert.equal(reused.status, "saved", `${harness.name} released compatibility slug`);
  const compatibility = await harness.query<{ slug: string }>(
    "select slug from articles where workspace_id = $1 and id = $2",
    "select slug from articles where workspace_id = ? and id = ?",
    [workspaceId, draft.id],
  );
  assert.equal(compatibility[0]?.slug, "renamed-draft");

  const createRace = await Promise.all([
    harness.repository.createDraftArticle(
      createRequest(article("article_create_race_a", "new-race", "Race A")),
    ),
    harness.repository.createDraftArticle(
      createRequest(article("article_create_race_b", "new-race", "Race B")),
    ),
  ]);
  assert.equal(outcomeCount(createRace, "saved"), 1);
  assert.equal(outcomeCount(createRace, "conflict"), 1);
  assert.equal(
    createRace.find((result) => result.status === "conflict")?.code,
    "SLUG_CONFLICT",
  );

  const raceA = article("article_save_race_a", "save-race-a", "Save race A");
  const raceB = article("article_save_race_b", "save-race-b", "Save race B");
  assert.equal((await harness.repository.createDraftArticle(createRequest(raceA))).status, "saved");
  assert.equal((await harness.repository.createDraftArticle(createRequest(raceB))).status, "saved");
  const saveRace = await Promise.all([
    harness.repository.saveDraftArticle(
      saveRequest({ ...raceA, slug: "shared-draft", title: "Save A" }, 1),
    ),
    harness.repository.saveDraftArticle(
      saveRequest({ ...raceB, slug: "shared-draft", title: "Save B" }, 1),
    ),
  ]);
  assert.equal(outcomeCount(saveRace, "saved"), 1);
  assert.equal(outcomeCount(saveRace, "conflict"), 1);
  assert.equal(
    saveRace.find((result) => result.status === "conflict")?.code,
    "SLUG_CONFLICT",
  );

  await harness.disableActor();
  const revisionCountBeforeForbidden = await harness.revisionCount(publicArticleId);
  const forbidden = await harness.repository.saveDraftArticle(
    saveRequest(article(publicArticleId, "private-guide", "Forbidden edit"), 3, [draftAssetHash]),
  );
  assert.deepEqual(forbidden, { status: "rejected", code: "ACTOR_FORBIDDEN" });
  assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
  await harness.enableActor();

  await harness.setActorRole("reviewer");
  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Reviewer edit"), 3, [draftAssetHash]),
    ),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
  await harness.setActorRole("editor");

  if (harness.lockAndDisableActor) {
    const releaseDisable = await harness.lockAndDisableActor();
    const racingSave = harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Disable race"), 3, [draftAssetHash]),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await releaseDisable();
    assert.deepEqual(await racingSave, { status: "rejected", code: "ACTOR_FORBIDDEN" });
    assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
    await harness.enableActor();
  }

  await harness.revokeActorSession();
  assert.deepEqual(
    await harness.repository.saveDraftArticle(
      saveRequest(article(publicArticleId, "private-guide", "Revoked edit"), 3, [draftAssetHash]),
    ),
    { status: "rejected", code: "ACTOR_FORBIDDEN" },
  );
  assert.equal(await harness.revisionCount(publicArticleId), revisionCountBeforeForbidden);
}

async function createPostgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 24 });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  try {
    await migratePostgres(database, { migrationsFolder: migrations.postgres });
    const revisionHash = await publicBaselineRevisionHash();
    await pool.query(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values ($1, 'drafts', 'Drafts', $2, $2)`,
      [workspaceId, now],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_at, updated_at
       ) values ($1, $2, 'owner@example.test', 'Owner', 'administrator', 'active', $3, $4, 600000, $5, $5)`,
      [ownerMemberId, workspaceId, "A".repeat(43), "B".repeat(43), now],
    );
    await pool.query(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values ($1, $2, 'editor@example.test', 'Editor', 'editor', 'active',
                 $3, $4, 600000, $5, $6, $6)`,
      [memberId, workspaceId, "C".repeat(43), "D".repeat(43), ownerMemberId, now],
    );
    await pool.query(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [sessionId, workspaceId, memberId, now, later],
    );
    await pool.query(
      `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
       values ($1, $2, 'guides', 'Guides', 0, $3, $3)`,
      [categoryId, workspaceId, now],
    );
    await pool.query(
      `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
       values ('asset_public', $1, $2, 'image/png', 1, $3, $4),
              ('asset_draft', $1, $5, 'image/png', 1, $6, $4)`,
      [workspaceId, publicAssetHash, Buffer.from([1]), now, draftAssetHash, Buffer.from([2])],
    );
    await pool.query(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, content_hash, status,
         is_faq, author_name, position, published_at, created_at, updated_at
       ) values ($1, $2, $3, 'public-guide', 'Public guide', $4, $5,
                 'published', true, 'OPAS', 0, $6, $6, $6)`,
      [publicArticleId, workspaceId, categoryId, "# Public guide\n\nPublic body.", "e".repeat(64), now],
    );
    await pool.query(
      `insert into article_assets (article_id, asset_id, workspace_id, created_at)
       values ($1, 'asset_public', $2, $3)`,
      [publicArticleId, workspaceId, now],
    );
    await pool.query(
      `insert into article_slug_claims
         (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
       values ($1, 'public-guide', $2, true, true)`,
      [workspaceId, publicArticleId],
    );
    await pool.query(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id, category_slug,
         category_name, slug, title, mdx, is_faq, author_name, position, revision_hash,
         change_kind, created_by_member_id, created_at
       ) values (
         'revision_public_1', $1, $2, 1, $3, 'guides', 'Guides', 'public-guide',
         'Public guide', $4, true, 'OPAS', 0, $5, 'manual', $6, $7
       )`,
      [workspaceId, publicArticleId, categoryId, "# Public guide\n\nPublic body.", revisionHash, memberId, now],
    );
    await pool.query(
      `insert into article_revision_assets
         (workspace_id, article_id, revision_id, revision_number, asset_id)
       values ($1, $2, 'revision_public_1', 1, 'asset_public')`,
      [workspaceId, publicArticleId],
    );
    await pool.query(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, published_revision_id, published_revision_number, review_state
       ) values ($1, $2, 'revision_public_1', 1, 'public-guide', 'revision_public_1', 1, 'published')`,
      [publicArticleId, workspaceId],
    );
    for (const statement of postgresTeamAuthoringGuardStatements) await pool.query(statement);
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }

  return {
    name: "Postgres",
    repository: createPostgresArticleDraftRepository(database, { clock: () => now }),
    repositoryForRevisionId(id) {
      return createPostgresArticleDraftRepository(database, {
        clock: () => now,
        createRevisionId: () => id,
      });
    },
    async addManifest(id, hashes) {
      await pool.query(
        "insert into asset_manifests (id, workspace_id, expires_at, created_at) values ($1, $2, $3, $4)",
        [id, workspaceId, later, now],
      );
      for (const hash of hashes) {
        await pool.query(
          `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
           select $1, id, workspace_id, $2 from assets where workspace_id = $3 and hash = $4`,
          [id, now, workspaceId, hash],
        );
      }
    },
    async disableActor() {
      await pool.query(
        "update workspace_members set status = 'disabled', updated_at = $1 where id = $2",
        [now, memberId],
      );
    },
    async enableActor() {
      await pool.query(
        "update workspace_members set status = 'active', updated_at = $1 where id = $2",
        [now, memberId],
      );
    },
    async inventory() {
      const [articleRows, articleAssets, evidenceChunks, indexingState] = await Promise.all([
        pool.query("select * from articles where id = $1 order by id", [publicArticleId]),
        pool.query("select * from article_assets where article_id = $1 order by asset_id", [publicArticleId]),
        pool.query("select * from evidence_chunks where article_id = $1 order by id", [publicArticleId]),
        pool.query("select * from workspace_index_states where workspace_id = $1", [workspaceId]),
      ]);
      return {
        articles: articleRows.rows,
        articleAssets: articleAssets.rows,
        evidenceChunks: evidenceChunks.rows,
        indexingState: indexingState.rows,
      };
    },
    async pauseAuthoring(paused) {
      await pool.query(
        `update workspace_authoring_controls
         set writes_paused = $1, generation = generation + 1, changed_at = $2
         where workspace_id = $3`,
        [paused, now, workspaceId],
      );
    },
    async revokeActorSession() {
      await pool.query(
        "update admin_sessions set revoked_at = $1 where id = $2 and revoked_at is null",
        [now, sessionId],
      );
    },
    async setActorRole(role) {
      await pool.query(
        "update workspace_members set role = $1, updated_at = $2 where id = $3",
        [role, now, memberId],
      );
    },
    async query<T extends object>(
      postgres: string,
      _sqlite: string,
      values: readonly unknown[] = [],
    ) {
      return (await pool.query(postgres, [...values])).rows as T[];
    },
    async revisionCount(articleId) {
      const result = await pool.query<{ count: string }>(
        "select count(*) as count from article_revisions where workspace_id = $1 and article_id = $2",
        [workspaceId, articleId],
      );
      return Number(result.rows[0].count);
    },
    async lockAndDisableActor() {
      const client: PoolClient = await pool.connect();
      await client.query("begin");
      await client.query("select id from workspace_members where id = $1 for update", [memberId]);
      await client.query(
        "update workspace_members set status = 'disabled', updated_at = $1 where id = $2",
        [now, memberId],
      );
      return async () => {
        await client.query("commit");
        client.release();
      };
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

async function createSqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  try {
    migrateSqlite(database, { migrationsFolder: migrations.sqlite });
    const revisionHash = await publicBaselineRevisionHash();
    client
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values (?, 'drafts', 'Drafts', ?, ?)`,
      )
      .run(workspaceId, now.getTime(), now.getTime());
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_at, updated_at
         ) values (?, ?, 'owner@example.test', 'Owner', 'administrator', 'active', ?, ?, 600000, ?, ?)`,
      )
      .run(ownerMemberId, workspaceId, "A".repeat(43), "B".repeat(43), now.getTime(), now.getTime());
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values (?, ?, 'editor@example.test', 'Editor', 'editor', 'active',
                   ?, ?, 600000, ?, ?, ?)`,
      )
      .run(
        memberId,
        workspaceId,
        "C".repeat(43),
        "D".repeat(43),
        ownerMemberId,
        now.getTime(),
        now.getTime(),
      );
    client
      .prepare(
        `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, workspaceId, memberId, now.getTime(), later.getTime());
    client
      .prepare(
        `insert into categories (id, workspace_id, slug, name, position, created_at, updated_at)
         values (?, ?, 'guides', 'Guides', 0, ?, ?)`,
      )
      .run(categoryId, workspaceId, now.getTime(), now.getTime());
    client
      .prepare(
        `insert into assets (id, workspace_id, hash, media_type, byte_size, content, created_at)
         values ('asset_public', ?, ?, 'image/png', 1, ?, ?),
                ('asset_draft', ?, ?, 'image/png', 1, ?, ?)`,
      )
      .run(
        workspaceId,
        publicAssetHash,
        Buffer.from([1]),
        now.getTime(),
        workspaceId,
        draftAssetHash,
        Buffer.from([2]),
        now.getTime(),
      );
    client
      .prepare(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, content_hash, status,
           is_faq, author_name, position, published_at, created_at, updated_at
         ) values (?, ?, ?, 'public-guide', 'Public guide', ?, ?,
                   'published', 1, 'OPAS', 0, ?, ?, ?)`,
      )
      .run(
        publicArticleId,
        workspaceId,
        categoryId,
        "# Public guide\n\nPublic body.",
        "e".repeat(64),
        now.getTime(),
        now.getTime(),
        now.getTime(),
      );
    client
      .prepare(
        `insert into article_assets (article_id, asset_id, workspace_id, created_at)
         values (?, 'asset_public', ?, ?)`,
      )
      .run(publicArticleId, workspaceId, now.getTime());
    client
      .prepare(
        `insert into article_slug_claims
           (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
         values (?, 'public-guide', ?, 1, 1)`,
      )
      .run(workspaceId, publicArticleId);
    client
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id, category_slug,
           category_name, slug, title, mdx, is_faq, author_name, position, revision_hash,
           change_kind, created_by_member_id, created_at
         ) values (
           'revision_public_1', ?, ?, 1, ?, 'guides', 'Guides', 'public-guide',
           'Public guide', ?, 1, 'OPAS', 0, ?, 'manual', ?, ?
         )`,
      )
      .run(
        workspaceId,
        publicArticleId,
        categoryId,
        "# Public guide\n\nPublic body.",
        revisionHash,
        memberId,
        now.getTime(),
      );
    client
      .prepare(
        `insert into article_revision_assets
           (workspace_id, article_id, revision_id, revision_number, asset_id)
         values (?, ?, 'revision_public_1', 1, 'asset_public')`,
      )
      .run(workspaceId, publicArticleId);
    client
      .prepare(
        `insert into article_heads (
           article_id, workspace_id, working_revision_id, working_revision_number,
           working_slug, published_revision_id, published_revision_number, review_state
         ) values (?, ?, 'revision_public_1', 1, 'public-guide', 'revision_public_1', 1, 'published')`,
      )
      .run(publicArticleId, workspaceId);
    for (const statement of sqliteTeamAuthoringGuardStatements) client.exec(statement);
  } catch (error) {
    client.close();
    throw error;
  }

  return {
    name: "SQLite",
    repository: createSqliteArticleDraftRepository(database, { clock: () => now }),
    repositoryForRevisionId(id) {
      return createSqliteArticleDraftRepository(database, {
        clock: () => now,
        createRevisionId: () => id,
      });
    },
    async addManifest(id, hashes) {
      client
        .prepare(
          "insert into asset_manifests (id, workspace_id, expires_at, created_at) values (?, ?, ?, ?)",
        )
        .run(id, workspaceId, later.getTime(), now.getTime());
      const insert = client.prepare(
        `insert into asset_manifest_items (manifest_id, asset_id, workspace_id, created_at)
         select ?, id, workspace_id, ? from assets where workspace_id = ? and hash = ?`,
      );
      for (const hash of hashes) insert.run(id, now.getTime(), workspaceId, hash);
    },
    async disableActor() {
      client
        .prepare("update workspace_members set status = 'disabled', updated_at = ? where id = ?")
        .run(now.getTime(), memberId);
    },
    async enableActor() {
      client
        .prepare("update workspace_members set status = 'active', updated_at = ? where id = ?")
        .run(now.getTime(), memberId);
    },
    async inventory() {
      return {
        articles: client
          .prepare("select * from articles where id = ? order by id")
          .all(publicArticleId),
        articleAssets: client
          .prepare("select * from article_assets where article_id = ? order by asset_id")
          .all(publicArticleId),
        evidenceChunks: client
          .prepare("select * from evidence_chunks where article_id = ? order by id")
          .all(publicArticleId),
        indexingState: client
          .prepare("select * from workspace_index_states where workspace_id = ?")
          .all(workspaceId),
      };
    },
    async pauseAuthoring(paused) {
      client
        .prepare(
          `update workspace_authoring_controls
           set writes_paused = ?, generation = generation + 1, changed_at = ?
           where workspace_id = ?`,
        )
        .run(paused ? 1 : 0, now.getTime(), workspaceId);
    },
    async revokeActorSession() {
      client
        .prepare("update admin_sessions set revoked_at = ? where id = ? and revoked_at is null")
        .run(now.getTime(), sessionId);
    },
    async setActorRole(role) {
      client
        .prepare("update workspace_members set role = ?, updated_at = ? where id = ?")
        .run(role, now.getTime(), memberId);
    },
    async query<T extends object>(
      _postgres: string,
      sqlite: string,
      values: readonly unknown[] = [],
    ) {
      return client.prepare(sqlite).all(...values) as T[];
    },
    async revisionCount(articleId) {
      return (
        client
          .prepare(
            "select count(*) as count from article_revisions where workspace_id = ? and article_id = ?",
          )
          .get(workspaceId, articleId) as { count: number }
      ).count;
    },
    async close() {
      client.close();
    },
  };
}

test("SQLite draft saves are atomic, revision-safe, and private", async () => {
  const harness = await createSqliteHarness();
  try {
    await exerciseRepository(harness);
  } finally {
    await harness.close();
  }
});

test(
  "Postgres draft saves are atomic, revision-safe, and private",
  { timeout: 120_000 },
  async () => {
    const harness = await createPostgresHarness();
    try {
      await exerciseRepository(harness);
    } finally {
      await harness.close();
    }
  },
);
