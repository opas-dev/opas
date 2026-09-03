// ABOUTME: Verifies bootstrap-gated atomic demo installation on Postgres and better-sqlite3.
// ABOUTME: Proves every seeded article has attributed history, emergency events, and evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

import { crofusionDemoContent } from "@/db/demo-crofusion";
import { demoContent, demoIds, demoMarkAssetHash } from "@/db/demo";
import { demoSeedProfile, initialDemoSeedReason } from "@/db/demo-seed";
import { createPostgresArticleDraftRepository } from "@/db/postgres/article-draft-repository";
import { reconcilePostgresDemoSeed } from "@/db/postgres/seed";
import * as postgresSchema from "@/db/schema/postgres";
import { createSqliteArticleDraftRepository } from "@/db/sqlite/article-draft-repository";
import { reconcileSqliteDemoSeed } from "@/db/sqlite/seed";
import * as sqliteSchema from "@/db/schema/sqlite";

const migrations = {
  postgres: resolve(process.cwd(), "drizzle/postgres"),
  sqlite: resolve(process.cwd(), "drizzle/sqlite"),
};
const memberId = "member_demo_seed_administrator";
const memberSessionId = "S".repeat(43);
const verifier = "A".repeat(43);
const operatorEditAt = new Date("2026-09-03T10:30:00.000Z");

function seededArticleEdit() {
  const source = demoContent.articles.find(
    ({ id }) => id === demoIds.publishedArticle,
  );
  if (!source) throw new Error("The published demo article is missing.");
  const title = `${source.title} — operator edit`;
  const body = source.mdx.slice(source.mdx.indexOf("\n"));
  return {
    article: {
      id: source.id,
      workspaceId: source.workspaceId,
      categoryId: source.categoryId,
      slug: source.slug,
      title,
      mdx: `# ${title}${body}\n\nThis saved operator revision remains private.`,
      isFaq: source.isFaq,
      authorName: source.authorName,
      position: "position" in source ? source.position : 0,
    },
    assetHashes: "assetHashes" in source ? source.assetHashes : [],
  };
}

function sqliteSeedSnapshot(client: Database.Database) {
  return JSON.stringify(
    Object.fromEntries(
      seedOwnedTables.map((table) => [
        table,
        client.prepare(`select * from ${table} order by 1, 2`).all(),
      ]),
    ),
  );
}

async function postgresSeedSnapshot(pool: Pool) {
  return Object.fromEntries(
    await Promise.all(
      seedOwnedTables.map(async (table) => [
        table,
        (await pool.query(`select * from ${table} order by 1, 2`)).rows,
      ] as const),
    ),
  );
}

async function saveAndSubmitSqliteOperatorRevision(
  client: Database.Database,
  database: NonNullable<Parameters<typeof reconcileSqliteDemoSeed>[0]>,
) {
  client
    .prepare(
      `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(
      memberSessionId,
      demoIds.workspace,
      memberId,
      operatorEditAt.getTime() - 1_000,
      operatorEditAt.getTime() + 8 * 60 * 60 * 1_000 - 1_000,
    );
  const repository = createSqliteArticleDraftRepository(database, {
    clock: () => operatorEditAt,
    createReviewEventId: () => "review_event_demo_operator_submit",
    createRevisionId: () => "revision_demo_operator_2",
  });
  const edited = seededArticleEdit();
  const saved = await repository.saveDraftArticle({
    actor: { memberId, sessionId: memberSessionId },
    article: edited.article,
    assets: { hashes: edited.assetHashes },
    changeKind: "manual",
    changeSummary: "Operator revision retained across seed reconciliation",
    expectedWorkingRevisionNumber: 1,
  });
  assert.equal(saved.status, "saved");
  if (saved.status !== "saved") throw new Error("Operator revision was not saved.");
  assert.equal(saved.revisionNumber, 2);
  const submitted = await repository.submitArticleForReview({
    actor: { memberId, sessionId: memberSessionId },
    articleId: edited.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: saved.revisionNumber,
    note: "Review the operator-authored revision",
    revisionId: saved.revisionId,
    workspaceId: demoIds.workspace,
  });
  assert.equal(submitted.status, "transitioned");
}

async function saveAndSubmitPostgresOperatorRevision(
  pool: Pool,
  database: NonNullable<Parameters<typeof reconcilePostgresDemoSeed>[0]>,
) {
  await pool.query(
    `insert into admin_sessions (id, workspace_id, member_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      memberSessionId,
      demoIds.workspace,
      memberId,
      new Date(operatorEditAt.getTime() - 1_000),
      new Date(operatorEditAt.getTime() + 8 * 60 * 60 * 1_000 - 1_000),
    ],
  );
  const repository = createPostgresArticleDraftRepository(database, {
    clock: () => operatorEditAt,
    createReviewEventId: () => "review_event_demo_operator_submit",
    createRevisionId: () => "revision_demo_operator_2",
  });
  const edited = seededArticleEdit();
  const saved = await repository.saveDraftArticle({
    actor: { memberId, sessionId: memberSessionId },
    article: edited.article,
    assets: { hashes: edited.assetHashes },
    changeKind: "manual",
    changeSummary: "Operator revision retained across seed reconciliation",
    expectedWorkingRevisionNumber: 1,
  });
  assert.equal(saved.status, "saved");
  if (saved.status !== "saved") throw new Error("Operator revision was not saved.");
  assert.equal(saved.revisionNumber, 2);
  const submitted = await repository.submitArticleForReview({
    actor: { memberId, sessionId: memberSessionId },
    articleId: edited.article.id,
    expectedReviewState: "editing",
    expectedWorkingRevisionNumber: saved.revisionNumber,
    note: "Review the operator-authored revision",
    revisionId: saved.revisionId,
    workspaceId: demoIds.workspace,
  });
  assert.equal(submitted.status, "transitioned");
}

test("fixed generic and CROFusion seed profiles retain their exact content", () => {
  for (const [profileId, content] of [
    ["opas", demoContent],
    ["crofusion", crofusionDemoContent],
  ] as const) {
    const profile = demoSeedProfile(profileId);
    assert.deepEqual(profile.workspace, content.workspace);
    assert.deepEqual(profile.categories, content.categories);
    assert.deepEqual(
      profile.articles.map((article) => ({
        assetHashes: article.assetHashes,
        authorName: article.authorName,
        categoryId: article.categoryId,
        id: article.id,
        isFaq: article.isFaq,
        mdx: article.mdx,
        position: article.position,
        publishedAt: article.publishedAt?.toISOString() ?? null,
        slug: article.slug,
        status: article.status,
        title: article.title,
        workspaceId: article.workspaceId,
      })),
      content.articles.map((article) => ({
        assetHashes: "assetHashes" in article ? article.assetHashes : [],
        authorName: article.authorName,
        categoryId: article.categoryId,
        id: article.id,
        isFaq: article.isFaq,
        mdx: article.mdx,
        position: "position" in article ? article.position : 0,
        publishedAt: article.publishedAt ?? null,
        slug: article.slug,
        status: article.status,
        title: article.title,
        workspaceId: article.workspaceId,
      })),
    );
    assert.deepEqual(profile.theme, content.theme);
  }
  assert.deepEqual(demoSeedProfile("opas").assets, demoContent.assets);
  assert.deepEqual(demoSeedProfile("crofusion").assets, []);
});

function createSqliteHarness() {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, { migrationsFolder: migrations.sqlite });
  return { client, database };
}

function bootstrapSqlite(client: Database.Database) {
  const now = Date.parse("2026-09-03T10:00:00.000Z");
  client
    .prepare(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(
      demoIds.workspace,
      demoContent.workspace.slug,
      demoContent.workspace.name,
      now,
      now,
    );
  client
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations, created_by_member_id,
         created_at, updated_at, last_login_at
       ) values (?, ?, ?, ?, 'administrator', 'active', ?, ?, 600000, null, ?, ?, null)`,
    )
    .run(
      memberId,
      demoIds.workspace,
      "seed-admin@opas.dev",
      "Seed Administrator",
      verifier,
      verifier,
      now,
      now,
    );
}

function scalar(client: Database.Database, source: string) {
  const row = client.prepare(source).get() as { value: number };
  return Number(row.value);
}

function clearSqliteSeed(client: Database.Database) {
  client.transaction(() => {
    client.prepare("delete from themes where workspace_id = ?").run(demoIds.workspace);
    client.prepare("delete from categories where workspace_id = ?").run(demoIds.workspace);
    client.prepare("delete from assets where workspace_id = ?").run(demoIds.workspace);
    client
      .prepare("delete from workspace_index_states where workspace_id = ?")
      .run(demoIds.workspace);
  })();
}

function assertNoSqliteSeedRows(client: Database.Database) {
  for (const table of [
    "categories",
    "themes",
    "articles",
    "article_revisions",
    "article_heads",
    "article_slug_claims",
    "article_review_events",
    "evidence_chunks",
    "embedding_jobs",
    "workspace_index_states",
    "assets",
    "article_assets",
    "article_revision_assets",
  ]) {
    assert.equal(
      scalar(
        client,
        `select count(*) as value from ${table} where workspace_id = '${demoIds.workspace}'`,
      ),
      0,
      `${table} retained a partial seed row`,
    );
  }
}

function assertCompleteSqliteSeed(client: Database.Database) {
  const publishedCount = demoContent.articles.filter(
    ({ status }) => status === "published",
  ).length;
  assert.equal(
    scalar(client, "select count(*) as value from categories"),
    demoContent.categories.length,
  );
  assert.equal(scalar(client, "select count(*) as value from themes"), 1);
  assert.equal(
    scalar(client, "select count(*) as value from articles"),
    demoContent.articles.length,
  );
  assert.equal(
    scalar(client, "select count(*) as value from article_revisions"),
    demoContent.articles.length,
  );
  assert.equal(
    scalar(
      client,
      `select count(*) as value from article_revisions
       where revision_number = 1 and change_kind = 'seed'
         and created_by_member_id = '${memberId}' and created_by_system_label is null`,
    ),
    demoContent.articles.length,
  );
  assert.equal(
    scalar(client, "select count(*) as value from article_heads"),
    demoContent.articles.length,
  );
  assert.equal(
    scalar(client, "select count(*) as value from article_slug_claims"),
    demoContent.articles.length,
  );
  assert.equal(
    scalar(
      client,
      `select count(*) as value from article_review_events
       where action = 'emergency_published' and note = '${initialDemoSeedReason}'
         and member_id = '${memberId}'`,
    ),
    publishedCount,
  );
  assert.equal(
    scalar(
      client,
      "select count(*) as value from article_heads where review_state = 'published' and published_revision_number = 1",
    ),
    publishedCount,
  );
  assert.equal(
    scalar(
      client,
      "select count(*) as value from article_heads where review_state = 'editing' and published_revision_id is null",
    ),
    demoContent.articles.length - publishedCount,
  );
  assert.equal(
    scalar(
      client,
      `select count(*) as value
       from articles
       inner join article_heads heads
         on heads.workspace_id = articles.workspace_id
         and heads.article_id = articles.id
       inner join article_revisions revisions
         on revisions.workspace_id = heads.workspace_id
         and revisions.article_id = heads.article_id
         and revisions.id = heads.published_revision_id
         and revisions.revision_number = heads.published_revision_number
       where articles.status = 'published'
         and (articles.category_id <> revisions.category_id
           or articles.slug <> revisions.slug
           or articles.title <> revisions.title
           or articles.mdx <> revisions.mdx
           or articles.is_faq <> revisions.is_faq
           or articles.author_name <> revisions.author_name
           or articles.position <> revisions.position
           or articles.content_hash is null
           or articles.published_at is null)`,
    ),
    0,
  );
  assert.equal(
    scalar(
      client,
      "select count(*) as value from articles where status = 'draft' and content_hash is null and published_at is null",
    ),
    demoContent.articles.length - publishedCount,
  );
  assert.equal(
    scalar(client, "select count(*) as value from evidence_chunks"),
    18,
  );
  assert.equal(
    scalar(client, "select count(*) as value from embedding_jobs"),
    publishedCount,
  );
  assert.equal(
    scalar(client, "select count(*) as value from workspace_index_states where generation = 1"),
    1,
  );
  assert.equal(
    scalar(
      client,
      `select count(*) as value from assets
       where hash = '${demoMarkAssetHash}' and byte_size = 134
         and media_type = 'image/png' and length(content) = byte_size`,
    ),
    1,
  );
  assert.equal(scalar(client, "select count(*) as value from article_assets"), 1);
  assert.equal(
    scalar(client, "select count(*) as value from article_revision_assets"),
    1,
  );
  const sqliteAsset = client
    .prepare("select content from assets where hash = ?")
    .get(demoMarkAssetHash) as { content: Buffer };
  assert.equal(
    createHash("sha256").update(sqliteAsset.content).digest("hex"),
    demoMarkAssetHash,
  );
  assert.deepEqual(client.pragma("foreign_key_check"), []);
}

test("SQLite demo seed requires the bootstrap administrator", async () => {
  const { client, database } = createSqliteHarness();
  try {
    await assert.rejects(
      reconcileSqliteDemoSeed(database),
      /DEMO_SEED_REQUIRES_BOOTSTRAP/u,
    );
    assertNoSqliteSeedRows(client);
  } finally {
    client.close();
  }
});

test("SQLite seed requires the original bootstrap administrator to remain active", async () => {
  const { client, database } = createSqliteHarness();
  try {
    bootstrapSqlite(client);
    const now = Date.parse("2026-09-03T10:05:00.000Z");
    client
      .prepare(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations, created_by_member_id,
           created_at, updated_at, last_login_at
         ) values (?, ?, ?, ?, 'administrator', 'active', ?, ?, 600000, ?, ?, ?, null)`,
      )
      .run(
        "member_invited_administrator",
        demoIds.workspace,
        "invited-admin@opas.dev",
        "Invited Administrator",
        verifier,
        verifier,
        memberId,
        now,
        now,
      );
    client
      .prepare("update workspace_members set status = 'disabled' where id = ?")
      .run(memberId);

    await assert.rejects(
      reconcileSqliteDemoSeed(database),
      /DEMO_SEED_REQUIRES_BOOTSTRAP/u,
    );
    assertNoSqliteSeedRows(client);
  } finally {
    client.close();
  }
});

test("SQLite seed creates exact revision 1 publication state and preserves reruns", async () => {
  const { client, database } = createSqliteHarness();
  try {
    bootstrapSqlite(client);
    const result = await reconcileSqliteDemoSeed(database, {
      configuredSiteUrl: "https://demo.opas.dev",
    });
    assert.equal(result.status, "seeded");
    assert.ok(result.statementCount > 0);
    assertCompleteSqliteSeed(client);

    client
      .prepare("update themes set name = ?, version = version + 1 where workspace_id = ?")
      .run("Operator theme", demoIds.workspace);
    await saveAndSubmitSqliteOperatorRevision(client, database);
    assert.equal(scalar(client, "select count(*) as value from article_revisions"), demoContent.articles.length + 1);
    assert.equal(
      scalar(
        client,
        `select count(*) as value from article_review_events
         where action = 'submitted' and revision_number = 2`,
      ),
      1,
    );
    const before = sqliteSeedSnapshot(client);
    const repeated = await reconcileSqliteDemoSeed(database, {
      configuredSiteUrl: "https://demo.opas.dev",
    });
    assert.deepEqual(repeated, {
      articleCount: demoContent.articles.length,
      revisionCount: demoContent.articles.length + 1,
      statementCount: 0,
      status: "verified_existing",
    });
    const after = sqliteSeedSnapshot(client);
    assert.equal(after, before);

    const originalContentHash = client
      .prepare("select content_hash as value from articles where id = ?")
      .get(demoIds.publishedArticle) as { value: string };
    client
      .prepare("update articles set content_hash = ? where id = ?")
      .run("f".repeat(64), demoIds.publishedArticle);
    await assert.rejects(
      reconcileSqliteDemoSeed(database),
      /DEMO_SEED_VERIFICATION_FAILED/u,
    );
    client
      .prepare("update articles set content_hash = ? where id = ?")
      .run(originalContentHash.value, demoIds.publishedArticle);

    client
      .prepare("update articles set title = ? where id = ?")
      .run("Corrupted public title", demoIds.publishedArticle);
    const corrupted = JSON.stringify(
      client.prepare("select * from articles order by id").all(),
    );
    await assert.rejects(
      reconcileSqliteDemoSeed(database),
      /DEMO_SEED_VERIFICATION_FAILED/u,
    );
    assert.equal(
      JSON.stringify(client.prepare("select * from articles order by id").all()),
      corrupted,
    );
  } finally {
    client.close();
  }
});

test("SQLite rolls back after every seed statement and the final retry succeeds", async () => {
  const { client, database } = createSqliteHarness();
  try {
    bootstrapSqlite(client);
    const complete = await reconcileSqliteDemoSeed(database, {
      configuredSiteUrl: "https://demo.opas.dev",
    });
    clearSqliteSeed(client);
    assertNoSqliteSeedRows(client);

    for (let statement = 1; statement <= complete.statementCount; statement += 1) {
      await assert.rejects(
        reconcileSqliteDemoSeed(database, {
          configuredSiteUrl: "https://demo.opas.dev",
          failAfterStatement: statement,
        }),
        /DEMO_SEED_INJECTED_FAILURE|malformed JSON/u,
      );
      assertNoSqliteSeedRows(client);
    }

    const retried = await reconcileSqliteDemoSeed(database, {
      configuredSiteUrl: "https://demo.opas.dev",
    });
    assert.equal(retried.status, "seeded");
    assertCompleteSqliteSeed(client);
  } finally {
    client.close();
  }
});

async function bootstrapPostgres(pool: Pool) {
  const now = new Date("2026-09-03T10:00:00.000Z");
  await pool.query(
    `insert into workspaces (id, slug, name, created_at, updated_at)
     values ($1, $2, $3, $4, $4)`,
    [demoIds.workspace, demoContent.workspace.slug, demoContent.workspace.name, now],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations, created_by_member_id,
       created_at, updated_at, last_login_at
     ) values ($1, $2, $3, $4, 'administrator', 'active', $5, $5, 600000, null, $6, $6, null)`,
    [
      memberId,
      demoIds.workspace,
      "seed-admin@opas.dev",
      "Seed Administrator",
      verifier,
      now,
    ],
  );
}

async function postgresCount(
  pool: Pool,
  source: string,
  values: readonly unknown[] = [],
) {
  const result = await pool.query<{ value: string }>(source, [...values]);
  return Number(result.rows[0]?.value ?? 0);
}

async function clearPostgresSeed(pool: Pool) {
  await pool.query("begin");
  try {
    await pool.query("delete from themes where workspace_id = $1", [demoIds.workspace]);
    await pool.query("delete from categories where workspace_id = $1", [demoIds.workspace]);
    await pool.query("delete from assets where workspace_id = $1", [demoIds.workspace]);
    await pool.query("delete from workspace_index_states where workspace_id = $1", [
      demoIds.workspace,
    ]);
    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  }
}

async function waitForPostgresLockWaiter(pool: Pool) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ value: string }>(
      `select count(*) as value
       from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]?.value ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("The seed did not reach its transaction lock.");
}

async function beginOrdinaryPostgresArticle(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  const now = new Date("2026-09-03T10:30:00.000Z");
  try {
    await client.query("begin");
    await client.query("select opas_assert_authoring_open($1)", [demoIds.workspace]);
    await client.query(
      `insert into categories
         (id, workspace_id, slug, name, description, position, version, created_at, updated_at)
       values ('category_race', $1, 'race', 'Race', null, 0, 1, $2, $2)`,
      [demoIds.workspace, now],
    );
    await client.query(
      `insert into articles
         (id, workspace_id, category_id, slug, title, mdx, content_hash, status,
          is_faq, author_name, position, published_at, created_at, updated_at)
       values ('article_race', $1, 'category_race', 'race-article', 'Race article',
         '# Race article', null, 'draft', false, 'Operator', 0, null, $2, $2)`,
      [demoIds.workspace, now],
    );
    await client.query(
      `insert into article_revisions
         (id, workspace_id, article_id, revision_number, category_id, category_slug,
          category_name, slug, title, mdx, is_faq, author_name, position, revision_hash,
          change_kind, created_by_member_id, created_by_system_label, change_summary,
          created_at, restored_from_revision_id)
       values ('revision_race', $1, 'article_race', 1, 'category_race', 'race', 'Race',
         'race-article', 'Race article', '# Race article', false, 'Operator', 0, $2,
         'manual', $3, null, null, $4, null)`,
      [demoIds.workspace, "b".repeat(64), memberId, now],
    );
    await client.query(
      `insert into article_slug_claims
         (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
       values ($1, 'race-article', 'article_race', true, true)`,
      [demoIds.workspace],
    );
    await client.query(
      `insert into article_heads
         (article_id, workspace_id, working_revision_id, working_revision_number,
          working_slug, published_revision_id, published_revision_number, review_state,
          submitted_by_member_id, archived_at, archived_by_member_id)
       values ('article_race', $1, 'revision_race', 1, 'race-article', null, null,
         'editing', null, null, null)`,
      [demoIds.workspace],
    );
    return client;
  } catch (error) {
    await client.query("rollback");
    client.release();
    throw error;
  }
}

const seedOwnedTables = [
  "categories",
  "themes",
  "articles",
  "article_revisions",
  "article_heads",
  "article_slug_claims",
  "article_review_events",
  "evidence_chunks",
  "embedding_jobs",
  "workspace_index_states",
  "assets",
  "article_assets",
  "article_revision_assets",
] as const;

async function assertNoPostgresSeedRows(pool: Pool) {
  for (const table of seedOwnedTables) {
    assert.equal(
      await postgresCount(
        pool,
        `select count(*) as value from ${table} where workspace_id = $1`,
        [demoIds.workspace],
      ),
      0,
      `${table} retained a partial seed row`,
    );
  }
}

async function assertCompletePostgresSeed(pool: Pool) {
  const publishedCount = demoContent.articles.filter(
    ({ status }) => status === "published",
  ).length;
  assert.equal(
    await postgresCount(pool, "select count(*) as value from categories"),
    demoContent.categories.length,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from themes"),
    1,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from articles"),
    demoContent.articles.length,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from article_revisions"),
    demoContent.articles.length,
  );
  assert.equal(
    await postgresCount(
      pool,
      `select count(*) as value from article_revisions
       where revision_number = 1 and change_kind = 'seed'
         and created_by_member_id = $1 and created_by_system_label is null`,
      [memberId],
    ),
    demoContent.articles.length,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from article_heads"),
    demoContent.articles.length,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from article_slug_claims"),
    demoContent.articles.length,
  );
  assert.equal(
    await postgresCount(
      pool,
      `select count(*) as value from article_review_events
       where action = 'emergency_published' and note = $1 and member_id = $2`,
      [initialDemoSeedReason, memberId],
    ),
    publishedCount,
  );
  assert.equal(
    await postgresCount(
      pool,
      "select count(*) as value from article_heads where review_state = 'published' and published_revision_number = 1",
    ),
    publishedCount,
  );
  assert.equal(
    await postgresCount(
      pool,
      "select count(*) as value from article_heads where review_state = 'editing' and published_revision_id is null",
    ),
    demoContent.articles.length - publishedCount,
  );
  assert.equal(
    await postgresCount(
      pool,
      `select count(*) as value
       from articles
       inner join article_heads heads
         on heads.workspace_id = articles.workspace_id
         and heads.article_id = articles.id
       inner join article_revisions revisions
         on revisions.workspace_id = heads.workspace_id
         and revisions.article_id = heads.article_id
         and revisions.id = heads.published_revision_id
         and revisions.revision_number = heads.published_revision_number
       where articles.status = 'published'
         and (articles.category_id is distinct from revisions.category_id
           or articles.slug is distinct from revisions.slug
           or articles.title is distinct from revisions.title
           or articles.mdx is distinct from revisions.mdx
           or articles.is_faq is distinct from revisions.is_faq
           or articles.author_name is distinct from revisions.author_name
           or articles.position is distinct from revisions.position
           or articles.content_hash is null
           or articles.published_at is null)`,
    ),
    0,
  );
  assert.equal(
    await postgresCount(
      pool,
      "select count(*) as value from articles where status = 'draft' and content_hash is null and published_at is null",
    ),
    demoContent.articles.length - publishedCount,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from evidence_chunks"),
    18,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from embedding_jobs"),
    publishedCount,
  );
  assert.equal(
    await postgresCount(
      pool,
      "select count(*) as value from workspace_index_states where generation = 1",
    ),
    1,
  );
  assert.equal(
    await postgresCount(
      pool,
      `select count(*) as value from assets
       where hash = $1 and byte_size = 134 and media_type = 'image/png'
         and octet_length(content) = byte_size`,
      [demoMarkAssetHash],
    ),
    1,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from article_assets"),
    1,
  );
  assert.equal(
    await postgresCount(pool, "select count(*) as value from article_revision_assets"),
    1,
  );
  const postgresAsset = await pool.query<{ content: Buffer }>(
    "select content from assets where hash = $1",
    [demoMarkAssetHash],
  );
  assert.equal(
    createHash("sha256").update(postgresAsset.rows[0]!.content).digest("hex"),
    demoMarkAssetHash,
  );
}

test(
  "Postgres requires bootstrap, preserves reruns, and rolls back after every statement",
  { timeout: 180_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    const database = createPostgresDatabase(pool, { schema: postgresSchema });
    try {
      await migratePostgres(database, { migrationsFolder: migrations.postgres });
      await assert.rejects(
        reconcilePostgresDemoSeed(database),
        /DEMO_SEED_REQUIRES_BOOTSTRAP/u,
      );
      await assertNoPostgresSeedRows(pool);

      await bootstrapPostgres(pool);
      const complete = await reconcilePostgresDemoSeed(database, {
        configuredSiteUrl: "https://demo.opas.dev",
      });
      assert.equal(complete.status, "seeded");
      assert.ok(complete.statementCount > 0);
      await assertCompletePostgresSeed(pool);

      await pool.query(
        "update themes set name = $1, version = version + 1 where workspace_id = $2",
        ["Operator theme", demoIds.workspace],
      );
      await saveAndSubmitPostgresOperatorRevision(pool, database);
      assert.equal(
        await postgresCount(pool, "select count(*) as value from article_revisions"),
        demoContent.articles.length + 1,
      );
      assert.equal(
        await postgresCount(
          pool,
          `select count(*) as value from article_review_events
           where action = 'submitted' and revision_number = 2`,
        ),
        1,
      );
      const before = await postgresSeedSnapshot(pool);
      const repeated = await reconcilePostgresDemoSeed(database, {
        configuredSiteUrl: "https://demo.opas.dev",
      });
      assert.deepEqual(repeated, {
        articleCount: demoContent.articles.length,
        revisionCount: demoContent.articles.length + 1,
        statementCount: 0,
        status: "verified_existing",
      });
      const after = await postgresSeedSnapshot(pool);
      assert.deepEqual(after, before);

      await clearPostgresSeed(pool);
      await assertNoPostgresSeedRows(pool);
      for (
        let statement = 1;
        statement <= complete.statementCount;
        statement += 1
      ) {
        await assert.rejects(
          reconcilePostgresDemoSeed(database, {
            configuredSiteUrl: "https://demo.opas.dev",
            failAfterStatement: statement,
          }),
          /DEMO_SEED_INJECTED_FAILURE|invalid input syntax/u,
        );
        await assertNoPostgresSeedRows(pool);
      }

      const retried = await reconcilePostgresDemoSeed(database, {
        configuredSiteUrl: "https://demo.opas.dev",
      });
      assert.equal(retried.status, "seeded");
      await assertCompletePostgresSeed(pool);

      await clearPostgresSeed(pool);
      const competingSeeds = await Promise.all([
        reconcilePostgresDemoSeed(database, {
          configuredSiteUrl: "https://demo.opas.dev",
        }),
        reconcilePostgresDemoSeed(database, {
          configuredSiteUrl: "https://demo.opas.dev",
        }),
      ]);
      assert.deepEqual(
        competingSeeds.map(({ status }) => status).sort(),
        ["seeded", "verified_existing"],
      );
      await assertCompletePostgresSeed(pool);

      await clearPostgresSeed(pool);
      const ordinaryArticle = await beginOrdinaryPostgresArticle(pool);
      const racedSeed = reconcilePostgresDemoSeed(database, {
        configuredSiteUrl: "https://demo.opas.dev",
      });
      await waitForPostgresLockWaiter(pool);
      await ordinaryArticle.query("commit");
      ordinaryArticle.release();
      assert.equal((await racedSeed).status, "verified_existing");
      assert.equal(
        await postgresCount(
          pool,
          "select count(*) as value from articles where id = 'article_race'",
        ),
        1,
      );
      assert.equal(
        await postgresCount(
          pool,
          "select count(*) as value from articles where id = any($1::text[])",
          [demoContent.articles.map(({ id }) => id)],
        ),
        0,
      );

      await clearPostgresSeed(pool);
      const pause = await pool.connect();
      let pauseCommitted = false;
      try {
        await pause.query("begin");
        await pause.query(
          `update workspace_authoring_controls
           set writes_paused = true, generation = generation + 1,
             changed_by_member_id = $1, changed_at = $2
           where workspace_id = $3`,
          [memberId, new Date("2026-09-03T11:00:00.000Z"), demoIds.workspace],
        );
        const pausedSeed = reconcilePostgresDemoSeed(database, {
          configuredSiteUrl: "https://demo.opas.dev",
        });
        await waitForPostgresLockWaiter(pool);
        await pause.query("commit");
        pauseCommitted = true;
        await assert.rejects(pausedSeed, { name: "AuthoringPausedError" });
        await assertNoPostgresSeedRows(pool);
      } finally {
        if (!pauseCommitted) await pause.query("rollback").catch(() => undefined);
        pause.release();
      }
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);
