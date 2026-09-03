// ABOUTME: Verifies the fence-held team-authoring schema backfill on SQLite and Postgres.
// ABOUTME: Covers deterministic restart, public projection safety, final guards, and cascades.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { getTableColumns, getTableName } from "drizzle-orm";
import { Pool } from "pg";

import { migrationArticleRevisionId } from "@/content/article-revision";
import { createPostgresTeamAuthoringBackfillStore } from "@/db/postgres/team-authoring-backfill";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteTeamAuthoringBackfillStore } from "@/db/sqlite/team-authoring-backfill";
import {
  createTeamAuthoringBaseline,
  runTeamAuthoringBackfill,
  teamAuthoringBackfillProjectionHash,
} from "@/db/team-authoring-backfill";
import { readPostgresAuthoringBackfillState } from "../scripts/authoring-control";

const sqliteMigrationDirectory = path.join(process.cwd(), "drizzle/sqlite");
const postgresMigrationDirectory = path.join(process.cwd(), "drizzle/postgres");
const fixedTime = 1_788_430_123_456;
const day = 86_400_000;

test("team-authoring table and column names match across dialects", () => {
  const pairs = [
    [postgresSchema.workspaceMembers, sqliteSchema.workspaceMembers],
    [postgresSchema.adminLoginWindows, sqliteSchema.adminLoginWindows],
    [postgresSchema.adminSessions, sqliteSchema.adminSessions],
    [postgresSchema.memberInvitations, sqliteSchema.memberInvitations],
    [postgresSchema.workspaceAuthoringMigrations, sqliteSchema.workspaceAuthoringMigrations],
    [postgresSchema.articleRevisions, sqliteSchema.articleRevisions],
    [postgresSchema.articleRevisionAssets, sqliteSchema.articleRevisionAssets],
    [postgresSchema.articleSlugClaims, sqliteSchema.articleSlugClaims],
    [postgresSchema.articleHeads, sqliteSchema.articleHeads],
    [postgresSchema.articleReviewEvents, sqliteSchema.articleReviewEvents],
    [postgresSchema.articlePreviewGrants, sqliteSchema.articlePreviewGrants],
  ] as const;
  for (const [postgresTable, sqliteTable] of pairs) {
    assert.equal(getTableName(postgresTable), getTableName(sqliteTable));
    assert.deepEqual(
      Object.keys(getTableColumns(postgresTable)).sort(),
      Object.keys(getTableColumns(sqliteTable)).sort(),
    );
  }
});

function migrationFiles(directory: string) {
  return readdirSync(directory)
    .filter((filename) => /^\d{4}_.+\.sql$/u.test(filename))
    .sort();
}

function sqliteMigration(filename: string) {
  return readFileSync(path.join(sqliteMigrationDirectory, filename), "utf8");
}

function applySqliteBeforeTeamAuthoring(database: Database.Database) {
  for (const filename of migrationFiles(sqliteMigrationDirectory)) {
    if (filename.startsWith("0011_")) break;
    database.transaction(() => database.exec(sqliteMigration(filename)))();
  }
}

function applySqliteTeamAuthoringSchema(database: Database.Database) {
  const filenames = migrationFiles(sqliteMigrationDirectory).filter(
    (candidate) => candidate.startsWith("0011_") || candidate.startsWith("0012_"),
  );
  assert.equal(filenames.length, 2);
  for (const filename of filenames) {
    database.transaction(() => database.exec(sqliteMigration(filename)))();
  }
}

function seedSqliteArticles(database: Database.Database, articleCount: number) {
  database
    .prepare(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values ('workspace_fixture', 'fixture', 'Fixture', ?, ?)`,
    )
    .run(fixedTime, fixedTime);
  database
    .prepare(
      `insert into categories
         (id, workspace_id, slug, name, description, position, created_at, updated_at)
       values ('category_fixture', 'workspace_fixture', 'guides', 'Guides', null, 0, ?, ?)`,
    )
    .run(fixedTime, fixedTime);
  database
    .prepare(
      `insert into assets
         (id, workspace_id, hash, media_type, byte_size, content, created_at)
       values ('asset_fixture', 'workspace_fixture', ?, 'image/png', 1, ?, ?)`,
    )
    .run("a".repeat(64), Buffer.from([1]), fixedTime);

  const insertArticle = database.prepare(
    `insert into articles (
       id, workspace_id, category_id, slug, title, mdx, content_hash, status,
       is_faq, author_name, position, published_at, created_at, updated_at
     ) values (?, 'workspace_fixture', 'category_fixture', ?, ?, ?, ?, ?, ?, 'OPAS', ?, ?, ?, ?)`,
  );
  const insertAsset = database.prepare(
    `insert into article_assets (article_id, asset_id, workspace_id, created_at)
     values (?, 'asset_fixture', 'workspace_fixture', ?)`,
  );
  for (let index = 0; index < articleCount; index += 1) {
    const published = index % 2 === 0;
    const id = `article_${String(index).padStart(3, "0")}`;
    insertArticle.run(
      id,
      `article-${index}`,
      `Article ${index}`,
      `# Article ${index}\n\nBody ${index}.`,
      String(index).padStart(64, "0"),
      published ? "published" : "draft",
      index % 3 === 0 ? 1 : 0,
      index,
      published ? fixedTime : null,
      fixedTime,
      fixedTime + index,
    );
    if (index < 3) insertAsset.run(id, fixedTime);
  }
}

function sqlitePublicProjection(database: Database.Database) {
  return {
    articleAssets: database
      .prepare("select * from article_assets order by article_id, asset_id")
      .all(),
    articles: database.prepare("select * from articles order by id").all(),
    categories: database
      .prepare(
        `select id, workspace_id, slug, name, description, position, created_at, updated_at
         from categories order by id`,
      )
      .all(),
  };
}

function pauseSqlite(database: Database.Database, paused: boolean) {
  database
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = ?, generation = generation + 1, changed_at = ?
       where workspace_id = 'workspace_fixture'`,
    )
    .run(paused ? 1 : 0, fixedTime + 10_000);
}

function insertSqliteAdministrator(database: Database.Database) {
  database
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values (
         'member_admin', 'workspace_fixture', 'admin@example.test', 'Admin',
         'administrator', 'active', ?, ?, 600000, null, ?, ?
       )`,
    )
    .run("A".repeat(43), "a".repeat(43), fixedTime, fixedTime);
}

type RevisionAwareFixtureState =
  | "complete"
  | "missing-head"
  | "missing-revision"
  | "missing-working-claim";

function revisionAwareFixture(key: string) {
  const workspaceId = `workspace_${key}`;
  const articleId = `article_${key}`;
  const categoryId = `category_${key}`;
  const memberId = `member_${key}`;
  const revisionId = `revision_${key}`;
  return {
    article: {
      articleId,
      assetIdsAndHashes: [],
      authorName: "OPAS",
      categoryId,
      categoryName: "Guides",
      categorySlug: "guides",
      isFaq: false,
      mdx: `# ${key}`,
      position: 0,
      slug: `article-${key}`,
      status: "draft" as const,
      title: key,
      workspaceId,
    },
    articleId,
    categoryId,
    memberId,
    revisionId,
    workspaceId,
  };
}

async function seedSqliteCompletedRevisionAwareWorkspace(
  database: Database.Database,
  key: string,
  state: RevisionAwareFixtureState,
) {
  const fixture = revisionAwareFixture(key);
  const baseline = await createTeamAuthoringBaseline(fixture.article);
  const projectionHash = await teamAuthoringBackfillProjectionHash(
    fixture.workspaceId,
    [],
  );
  database
    .prepare(
      `insert into workspaces (id, slug, name, created_at, updated_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(fixture.workspaceId, key, key, fixedTime, fixedTime);
  database
    .prepare(
      `insert into categories
         (id, workspace_id, slug, name, description, position, created_at, updated_at)
       values (?, ?, 'guides', 'Guides', null, 0, ?, ?)`,
    )
    .run(fixture.categoryId, fixture.workspaceId, fixedTime, fixedTime);
  database
    .prepare(
      `insert into workspace_members (
         id, workspace_id, normalized_email, display_name, role, status,
         password_salt, password_digest, password_iterations,
         created_by_member_id, created_at, updated_at
       ) values (?, ?, ?, ?, 'administrator', 'active', ?, ?, 600000, null, ?, ?)`,
    )
    .run(
      fixture.memberId,
      fixture.workspaceId,
      `${key}@example.test`,
      key,
      "A".repeat(43),
      "a".repeat(43),
      fixedTime,
      fixedTime,
    );
  database
    .prepare(
      `insert into workspace_authoring_migrations
         (workspace_id, version, article_count, projection_hash, completed_at)
       values (?, 1, 0, ?, ?)`,
    )
    .run(fixture.workspaceId, projectionHash, fixedTime);
  database
    .prepare(
      `insert into articles (
         id, workspace_id, category_id, slug, title, mdx, content_hash, status,
         is_faq, author_name, position, published_at, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, null, 'draft', 0, 'OPAS', 0, null, ?, ?)`,
    )
    .run(
      fixture.articleId,
      fixture.workspaceId,
      fixture.categoryId,
      fixture.article.slug,
      fixture.article.title,
      fixture.article.mdx,
      fixedTime,
      fixedTime,
    );
  database
    .prepare(
      `insert into article_revisions (
         id, workspace_id, article_id, revision_number, category_id, category_slug,
         category_name, slug, title, mdx, is_faq, author_name, position,
         revision_hash, change_kind, created_by_member_id, created_by_system_label,
         change_summary, created_at, restored_from_revision_id
       ) values (?, ?, ?, 1, ?, 'guides', 'Guides', ?, ?, ?, 0, 'OPAS', 0,
                 ?, 'manual', ?, null, null, ?, null)`,
    )
    .run(
      fixture.revisionId,
      fixture.workspaceId,
      fixture.articleId,
      fixture.categoryId,
      fixture.article.slug,
      fixture.article.title,
      fixture.article.mdx,
      baseline.revisionHash,
      fixture.memberId,
      fixedTime,
    );
  database
    .prepare(
      `insert into article_slug_claims
         (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
       values (?, ?, ?, 1, 1)`,
    )
    .run(fixture.workspaceId, fixture.article.slug, fixture.articleId);
  database
    .prepare(
      `insert into article_heads (
         article_id, workspace_id, working_revision_id, working_revision_number,
         working_slug, published_revision_id, published_revision_number,
         review_state, submitted_by_member_id, archived_at, archived_by_member_id
       ) values (?, ?, ?, 1, ?, null, null, 'editing', null, null, null)`,
    )
    .run(
      fixture.articleId,
      fixture.workspaceId,
      fixture.revisionId,
      fixture.article.slug,
    );

  if (state === "missing-head") {
    database.prepare("delete from article_heads where article_id = ?").run(fixture.articleId);
  } else if (state === "missing-revision") {
    database.pragma("foreign_keys = OFF");
    database.prepare("delete from article_revisions where id = ?").run(fixture.revisionId);
    database.pragma("foreign_keys = ON");
  } else if (state === "missing-working-claim") {
    database
      .prepare(
        `update article_slug_claims set working_claim = 0
         where workspace_id = ? and normalized_slug = ?`,
      )
      .run(fixture.workspaceId, fixture.article.slug);
  }
  database
    .prepare(
      `update workspace_authoring_controls
       set writes_paused = 1, generation = generation + 1, changed_at = ?
       where workspace_id = ?`,
    )
    .run(fixedTime + 1, fixture.workspaceId);
  return fixture;
}

test("SQLite installs guards after a completed empty ledger gains revision-aware content", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applySqliteBeforeTeamAuthoring(database);
    applySqliteTeamAuthoringSchema(database);
    await seedSqliteCompletedRevisionAwareWorkspace(database, "complete", "complete");
    const store = createSqliteTeamAuthoringBackfillStore(database);

    assert.deepEqual(await store.assertAllWorkspacesPaused(), {
      completedWorkspaceIds: ["workspace_complete"],
      guardsInstalled: false,
      pendingArticleCount: 0,
      workspaceIds: ["workspace_complete"],
    });
    const result = await runTeamAuthoringBackfill(store);
    assert.equal(result.alreadyCompleted, false);
    assert.equal(result.articleCount, 0);
    assert.equal(result.chunkCount, 0);
    assert.deepEqual(
      database.prepare("select id, change_kind from article_revisions").all(),
      [{ change_kind: "manual", id: "revision_complete" }],
    );
    assert.equal((await store.assertAllWorkspacesPaused()).guardsInstalled, true);
    assert.equal((await runTeamAuthoringBackfill(store)).alreadyCompleted, true);
  } finally {
    database.close();
  }
});

test("SQLite rejects completed ledgers with incomplete revision-aware content", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applySqliteBeforeTeamAuthoring(database);
    applySqliteTeamAuthoringSchema(database);
    await seedSqliteCompletedRevisionAwareWorkspace(database, "missing-head", "missing-head");
    await seedSqliteCompletedRevisionAwareWorkspace(
      database,
      "missing-revision",
      "missing-revision",
    );
    await seedSqliteCompletedRevisionAwareWorkspace(
      database,
      "missing-working-claim",
      "missing-working-claim",
    );
    const store = createSqliteTeamAuthoringBackfillStore(database);

    assert.equal((await store.assertAllWorkspacesPaused()).pendingArticleCount, 3);
    await assert.rejects(
      runTeamAuthoringBackfill(store),
      /AUTHORING_BACKFILL_LEDGER_PARTIAL/u,
    );
    assert.equal((await store.assertAllWorkspacesPaused()).guardsInstalled, false);
  } finally {
    database.close();
  }
});

test("SQLite backfill resumes deterministically and installs transition-safe guards", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applySqliteBeforeTeamAuthoring(database);
    seedSqliteArticles(database, 51);
    const before = sqlitePublicProjection(database);
    pauseSqlite(database, true);
    applySqliteTeamAuthoringSchema(database);
    const store = createSqliteTeamAuthoringBackfillStore(database);

    await assert.rejects(
      runTeamAuthoringBackfill(store, { interruptAfterChunks: 1 }),
      /AUTHORING_BACKFILL_INTERRUPTED/u,
    );
    assert.equal(
      (database.prepare("select count(*) as count from article_revisions").get() as {
        count: number;
      }).count,
      25,
    );
    assert.equal(
      (database
        .prepare("select count(*) as count from workspace_authoring_migrations")
        .get() as { count: number }).count,
      0,
    );

    const completed = await runTeamAuthoringBackfill(store, {
      clock: () => new Date(fixedTime + 20_000),
    });
    assert.equal(completed.articleCount, 51);
    assert.equal(completed.chunkCount, 3);
    assert.deepEqual(sqlitePublicProjection(database), before);
    assert.equal(
      (database
        .prepare(
          `select count(*) as count
           from article_revisions revision
           inner join articles article
             on article.id = revision.article_id
             and article.workspace_id = revision.workspace_id
           where revision.created_at = article.updated_at`,
        )
        .get() as { count: number }).count,
      51,
    );

    database
      .prepare(
        "delete from workspace_authoring_migrations where workspace_id = 'workspace_fixture'",
      )
      .run();
    const beforeIncompleteReplay = {
      heads: (
        database.prepare("select count(*) as count from article_heads").get() as {
          count: number;
        }
      ).count,
      revisions: (
        database.prepare("select count(*) as count from article_revisions").get() as {
          count: number;
        }
      ).count,
    };
    await assert.rejects(
      runTeamAuthoringBackfill(store),
      /AUTHORING_BACKFILL_LEDGER_PARTIAL/u,
    );
    assert.deepEqual(
      {
        heads: (
          database.prepare("select count(*) as count from article_heads").get() as {
            count: number;
          }
        ).count,
        revisions: (
          database.prepare("select count(*) as count from article_revisions").get() as {
            count: number;
          }
        ).count,
      },
      beforeIncompleteReplay,
    );
    const ledger = completed.completion[0];
    database
      .prepare(
        `insert into workspace_authoring_migrations
           (workspace_id, version, article_count, projection_hash, completed_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        ledger.workspaceId,
        ledger.version,
        ledger.articleCount,
        ledger.projectionHash,
        ledger.completedAt.getTime(),
      );
    assert.deepEqual(
      database
        .prepare(
          `select article.status, head.review_state, head.published_revision_number
           from article_heads head
           inner join articles article on article.id = head.article_id
           order by article.id limit 2`,
        )
        .all(),
      [
        {
          published_revision_number: 1,
          review_state: "published",
          status: "published",
        },
        {
          published_revision_number: null,
          review_state: "editing",
          status: "draft",
        },
      ],
    );
    assert.equal(
      (
        database
          .prepare("select id from article_revisions where article_id = 'article_000'")
          .get() as { id: string }
      ).id,
      await migrationArticleRevisionId("workspace_fixture", "article_000"),
    );

    const repeated = await runTeamAuthoringBackfill(store);
    assert.equal(repeated.alreadyCompleted, true);
    assert.equal(
      (database.prepare("select count(*) as count from article_revisions").get() as {
        count: number;
      }).count,
      51,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `insert into article_slug_claims
               (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
             values ('workspace_fixture', 'paused-claim', 'article_000', 1, 0)`,
          )
          .run(),
      /AUTHORING_PAUSED/u,
    );

    pauseSqlite(database, false);
    insertSqliteAdministrator(database);
    assert.throws(
      () =>
        database
          .prepare(
            `insert into member_invitations (
               id, workspace_id, kind, normalized_email, target_role, member_id,
               token_digest, created_by_member_id, created_at, expires_at
             ) values (
               'bad_invite', 'workspace_fixture', 'invite', 'bad@example.test', null,
               null, ?, null, ?, ?
             )`,
          )
          .run("1".repeat(64), fixedTime, fixedTime + 2 * day),
      /member_invitations_target_check|OPERATOR_INVITATION_INVALID/u,
    );
    database
      .prepare(
        `insert into member_invitations (
           id, workspace_id, kind, normalized_email, target_role, member_id,
           token_digest, created_by_member_id, created_at, expires_at
         ) values (
           'operator_reset', 'workspace_fixture', 'credential_reset',
           'admin@example.test', null, 'member_admin', ?, null, ?, ?
         )`,
      )
      .run("2".repeat(64), fixedTime, fixedTime + 3_600_000);

    assert.throws(
      () =>
        database
          .prepare(
            "update article_revisions set title = 'Changed' where article_id = 'article_000'",
          )
          .run(),
      /ARTICLE_REVISION_IMMUTABLE/u,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `insert into article_revisions (
               id, workspace_id, article_id, revision_number, category_id,
               category_slug, category_name, slug, title, mdx, is_faq,
               author_name, position, revision_hash, change_kind,
               created_by_member_id, created_by_system_label, created_at
             )
             select 'revision_missing_actor', workspace_id, article_id, 99,
               category_id, category_slug, category_name, slug, title, mdx, is_faq,
               author_name, position, ?, 'migration', null, null, ?
             from article_revisions where article_id = 'article_001' and revision_number = 1`,
          )
          .run("c".repeat(64), fixedTime + 1),
      /article_revisions_actor_check/u,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "update article_heads set working_revision_number = 2 where article_id = 'article_001'",
          )
          .run(),
      /FOREIGN KEY constraint failed|ARTICLE_HEAD_INVALID/u,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "update article_heads set archived_at = ? where article_id = 'article_000'",
          )
          .run(fixedTime),
      /ARTICLE_HEAD_INVALID/u,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "update article_heads set review_state = 'invalid' where article_id = 'article_001'",
          )
          .run(),
      /article_heads_review_state_check|CHECK constraint failed/u,
    );
    assert.throws(
      () =>
        database
          .prepare("update articles set title = 'Stale write' where id = 'article_001'")
          .run(),
      /ARTICLE_MATERIALIZATION_INVALID/u,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `insert into articles (
               id, workspace_id, category_id, slug, title, mdx, status, is_faq,
               author_name, position, created_at, updated_at
             ) values (
               'article_headless', 'workspace_fixture', 'category_fixture', 'headless',
               'Headless', '# Headless', 'published', 0, 'OPAS', 0, ?, ?
             )`,
          )
          .run(fixedTime, fixedTime),
      /ARTICLE_MATERIALIZATION_INVALID/u,
    );

    const firstRevision = database
      .prepare("select * from article_revisions where article_id = 'article_000'")
      .get() as Record<string, unknown>;
    database
      .prepare(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id, category_slug,
           category_name, slug, title, mdx, is_faq, author_name, position,
           revision_hash, change_kind, created_by_member_id, created_at
         ) values (
           'revision_renamed', 'workspace_fixture', 'article_000', 2,
           'category_fixture', 'guides', 'Guides', 'renamed-article', 'Renamed article',
           '# Renamed article', 0, 'OPAS', 0, ?, 'manual', 'member_admin', ?
         )`,
      )
      .run("b".repeat(64), fixedTime + 30_000);
    database
      .prepare(
        `insert into article_slug_claims
           (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
         values ('workspace_fixture', 'renamed-article', 'article_000', 1, 0)`,
      )
      .run();
    database
      .prepare(
        `update article_heads
         set working_revision_id = 'revision_renamed', working_revision_number = 2,
             working_slug = 'renamed-article', review_state = 'editing'
         where article_id = 'article_000'`,
      )
      .run();
    database
      .prepare(
        `update article_slug_claims set working_claim = 0
         where workspace_id = 'workspace_fixture'
           and normalized_slug = 'article-0'`,
      )
      .run();
    assert.equal(firstRevision.slug, "article-0");

    database.transaction(() => {
      database
        .prepare(
          "update article_heads set review_state = 'approved' where article_id = 'article_000'",
        )
        .run();
      database
        .prepare("update articles set status = 'draft' where id = 'article_000'")
        .run();
      database
        .prepare(
          `update article_slug_claims set article_row_claim = 1
           where workspace_id = 'workspace_fixture'
             and normalized_slug = 'renamed-article'`,
        )
        .run();
      database
        .prepare(
          `update article_heads
           set published_revision_id = 'revision_renamed', published_revision_number = 2
           where article_id = 'article_000'`,
        )
        .run();
      database
        .prepare(
          `update articles
           set slug = 'renamed-article', title = 'Renamed article',
               mdx = '# Renamed article', is_faq = 0, position = 0, status = 'published'
           where id = 'article_000'`,
        )
        .run();
      database
        .prepare(
          "update article_heads set review_state = 'published' where article_id = 'article_000'",
        )
        .run();
      database
        .prepare(
          `delete from article_slug_claims
           where workspace_id = 'workspace_fixture' and normalized_slug = 'article-0'`,
        )
        .run();
    })();
    assert.equal(
      (
        database
          .prepare("select slug from articles where id = 'article_000'")
          .get() as { slug: string }
      ).slug,
      "renamed-article",
    );

    const evolvedHistoryCount = (
      database.prepare("select count(*) as count from article_revisions").get() as {
        count: number;
      }
    ).count;
    pauseSqlite(database, true);
    const evolvedRepeat = await runTeamAuthoringBackfill(store);
    assert.equal(evolvedRepeat.alreadyCompleted, true);
    assert.equal(evolvedRepeat.articleCount, 51);
    assert.equal(
      (database.prepare("select count(*) as count from article_revisions").get() as {
        count: number;
      }).count,
      evolvedHistoryCount,
    );
    database
      .prepare(
        `update workspace_authoring_migrations
         set projection_hash = ?
         where workspace_id = 'workspace_fixture' and version = 1`,
      )
      .run("0".repeat(64));
    await assert.rejects(
      runTeamAuthoringBackfill(store),
      /AUTHORING_BACKFILL_LEDGER_MISMATCH/u,
    );
    database
      .prepare(
        `update workspace_authoring_migrations
         set projection_hash = ?
         where workspace_id = 'workspace_fixture' and version = 1`,
      )
      .run(ledger.projectionHash);
    database
      .prepare(
        `insert into workspaces (id, slug, name, created_at, updated_at)
         values ('workspace_late', 'late', 'Late workspace', ?, ?)`,
      )
      .run(fixedTime + 40_000, fixedTime + 40_000);
    database
      .prepare(
        `update workspace_authoring_controls
         set writes_paused = 1, generation = generation + 1, changed_at = ?
         where workspace_id = 'workspace_late'`,
      )
      .run(fixedTime + 40_001);
    const lateWorkspace = await runTeamAuthoringBackfill(store);
    assert.equal(lateWorkspace.alreadyCompleted, false);
    assert.equal(lateWorkspace.articleCount, 51);
    assert.deepEqual(
      database
        .prepare(
          `select article_count, version
           from workspace_authoring_migrations
           where workspace_id = 'workspace_late'`,
        )
        .all(),
      [{ article_count: 0, version: 1 }],
    );
    assert.equal(
      (database.prepare("select count(*) as count from article_revisions").get() as {
        count: number;
      }).count,
      evolvedHistoryCount,
    );
    pauseSqlite(database, false);

    assert.throws(
      () =>
        database
          .prepare("delete from categories where id = 'category_fixture'")
          .run(),
      /CATEGORY_IN_USE/u,
    );

    database
      .prepare(
        `insert into article_preview_grants (
           id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
         ) values (?, 'workspace_fixture', 'revision_renamed', 'member_admin', ?, ?)`,
      )
      .run("P".repeat(43), fixedTime + 7 * day, fixedTime);
    pauseSqlite(database, true);
    database
      .prepare(
        `update article_preview_grants
         set revoked_at = ?, revoked_by_member_id = 'member_admin'
         where id = ?`,
      )
      .run(fixedTime + 1, "P".repeat(43));
    assert.throws(
      () =>
        database
          .prepare("update article_preview_grants set expires_at = ? where id = ?")
          .run(fixedTime + 8 * day, "P".repeat(43)),
      /PREVIEW_GRANT_IMMUTABLE/u,
    );

    pauseSqlite(database, false);
    database
      .prepare("delete from article_heads where article_id = 'article_002'")
      .run();
    pauseSqlite(database, true);
    await assert.rejects(
      runTeamAuthoringBackfill(store),
      /AUTHORING_BACKFILL_LEDGER_PARTIAL/u,
    );

    pauseSqlite(database, false);
    database.prepare("delete from workspaces where id = 'workspace_fixture'").run();
    assert.equal((database.pragma("foreign_key_check") as unknown[]).length, 0);
    assert.equal(
      (database.prepare("select count(*) as count from article_revisions").get() as {
        count: number;
      }).count,
      0,
    );
  } finally {
    database.close();
  }
});

test("SQLite clean install records a zero-article bootstrap ledger", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  try {
    applySqliteBeforeTeamAuthoring(database);
    applySqliteTeamAuthoringSchema(database);
    const store = createSqliteTeamAuthoringBackfillStore(database);
    const fresh = await runTeamAuthoringBackfill(store, {
      clock: () => new Date(fixedTime),
    });
    assert.equal(fresh.articleCount, 0);

    database.transaction(() => {
      database
        .prepare(
          `insert into workspaces (id, slug, name, created_at, updated_at)
           values ('workspace_clean', 'clean', 'Clean', ?, ?)`,
        )
        .run(fixedTime, fixedTime);
      database
        .prepare(
          `update workspace_authoring_controls
           set writes_paused = 1, generation = generation + 1, changed_at = ?
           where workspace_id = 'workspace_clean'`,
        )
        .run(fixedTime + 1);
      assert.throws(
        () =>
          database
            .prepare(
              `insert into workspace_members (
                 id, workspace_id, normalized_email, display_name, role, status,
                 password_salt, password_digest, password_iterations,
                 created_by_member_id, created_at, updated_at
               ) values (
                 'member_invalid', 'workspace_clean', 'invalid@clean.test', 'Invalid',
                 'administrator', 'disabled', ?, ?, 600000, null, ?, ?
               )`,
            )
            .run("A".repeat(43), "a".repeat(43), fixedTime, fixedTime),
        /MEMBER_BOOTSTRAP_INVALID/u,
      );
      database
        .prepare(
          `insert into workspace_members (
             id, workspace_id, normalized_email, display_name, role, status,
             password_salt, password_digest, password_iterations,
             created_by_member_id, created_at, updated_at
           ) values (
             'member_clean', 'workspace_clean', 'admin@clean.test', 'Admin',
             'administrator', 'active', ?, ?, 600000, null, ?, ?
           )`,
        )
        .run("A".repeat(43), "a".repeat(43), fixedTime, fixedTime);
    })();

    const completed = await runTeamAuthoringBackfill(store, {
      clock: () => new Date(fixedTime + 2),
    });
    assert.equal(completed.articleCount, 0);
    assert.equal(completed.alreadyCompleted, false);
    assert.deepEqual(
      database
        .prepare(
          `select article_count, version
           from workspace_authoring_migrations
           where workspace_id = 'workspace_clean'`,
        )
        .all(),
      [{ article_count: 0, version: 1 }],
    );
    assert.equal((await runTeamAuthoringBackfill(store)).alreadyCompleted, true);
  } finally {
    database.close();
  }
});

test("SQLite backfill resumes from every 25-row chunk boundary", async () => {
  for (const interruptAfterChunks of [1, 2, 3]) {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      applySqliteBeforeTeamAuthoring(database);
      seedSqliteArticles(database, 51);
      const before = sqlitePublicProjection(database);
      pauseSqlite(database, true);
      applySqliteTeamAuthoringSchema(database);
      const store = createSqliteTeamAuthoringBackfillStore(database);
      await assert.rejects(
        runTeamAuthoringBackfill(store, { interruptAfterChunks }),
        /AUTHORING_BACKFILL_INTERRUPTED/u,
      );
      assert.equal(
        (
          database.prepare("select count(*) as count from article_revisions").get() as {
            count: number;
          }
        ).count,
        Math.min(interruptAfterChunks * 25, 51),
      );
      await runTeamAuthoringBackfill(store);
      assert.deepEqual(sqlitePublicProjection(database), before);
      assert.deepEqual(
        database
          .prepare(
            `select count(*) as revisions, count(distinct id) as identities
             from article_revisions`,
          )
          .get(),
        { identities: 51, revisions: 51 },
      );
      assert.equal((await runTeamAuthoringBackfill(store)).alreadyCompleted, true);
      assert.deepEqual(database.pragma("foreign_key_check"), []);
    } finally {
      database.close();
    }
  }
});

test("SQLite Phase 16.3 DDL fails before creating tables without a paused control", () => {
  for (const missingControl of [false, true]) {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      applySqliteBeforeTeamAuthoring(database);
      database
        .prepare("insert into workspaces (id, slug, name) values ('unsafe', 'unsafe', 'Unsafe')")
        .run();
      if (missingControl) {
        database
          .prepare("delete from workspace_authoring_controls where workspace_id = 'unsafe'")
          .run();
      }
      assert.throws(() => applySqliteTeamAuthoringSchema(database));
      assert.deepEqual(
        database
          .prepare(
            "select count(*) as count from sqlite_master where type = 'table' and name = 'workspace_members'",
          )
          .get(),
        { count: 0 },
      );
    } finally {
      database.close();
    }
  }
});

async function applyPostgresMigration(pool: Pool, filename: string) {
  const source = readFileSync(path.join(postgresMigrationDirectory, filename), "utf8");
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function applyPostgresBeforeTeamAuthoring(pool: Pool) {
  for (const filename of migrationFiles(postgresMigrationDirectory)) {
    if (filename.startsWith("0011_")) break;
    await applyPostgresMigration(pool, filename);
  }
}

async function applyPostgresTeamAuthoringSchema(pool: Pool) {
  const filenames = migrationFiles(postgresMigrationDirectory).filter(
    (candidate) => candidate.startsWith("0011_") || candidate.startsWith("0012_"),
  );
  assert.equal(filenames.length, 2);
  for (const filename of filenames) await applyPostgresMigration(pool, filename);
}

function postgresRows(pool: Pool) {
  return async (source: string, parameters: readonly unknown[]) =>
    (await pool.query(source, [...parameters])).rows as readonly Record<string, unknown>[];
}

async function seedPostgresCompletedRevisionAwareWorkspace(
  pool: Pool,
  key: string,
  state: RevisionAwareFixtureState,
) {
  const fixture = revisionAwareFixture(key);
  const baseline = await createTeamAuthoringBaseline(fixture.article);
  const projectionHash = await teamAuthoringBackfillProjectionHash(
    fixture.workspaceId,
    [],
  );
  await pool.query(
    `insert into workspaces (id, slug, name, created_at, updated_at)
     values ($1, $2, $2, $3, $3)`,
    [fixture.workspaceId, key, new Date(fixedTime)],
  );
  await pool.query(
    `insert into categories
       (id, workspace_id, slug, name, description, position, created_at, updated_at)
     values ($1, $2, 'guides', 'Guides', null, 0, $3, $3)`,
    [fixture.categoryId, fixture.workspaceId, new Date(fixedTime)],
  );
  await pool.query(
    `insert into workspace_members (
       id, workspace_id, normalized_email, display_name, role, status,
       password_salt, password_digest, password_iterations,
       created_by_member_id, created_at, updated_at
     ) values ($1, $2, $3, $4, 'administrator', 'active', $5, $6, 600000, null, $7, $7)`,
    [
      fixture.memberId,
      fixture.workspaceId,
      `${key}@example.test`,
      key,
      "A".repeat(43),
      "a".repeat(43),
      new Date(fixedTime),
    ],
  );
  await pool.query(
    `insert into workspace_authoring_migrations
       (workspace_id, version, article_count, projection_hash, completed_at)
     values ($1, 1, 0, $2, $3)`,
    [fixture.workspaceId, projectionHash, new Date(fixedTime)],
  );
  await pool.query(
    `insert into articles (
       id, workspace_id, category_id, slug, title, mdx, content_hash, status,
       is_faq, author_name, position, published_at, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, null, 'draft', false, 'OPAS', 0, null, $7, $7)`,
    [
      fixture.articleId,
      fixture.workspaceId,
      fixture.categoryId,
      fixture.article.slug,
      fixture.article.title,
      fixture.article.mdx,
      new Date(fixedTime),
    ],
  );
  await pool.query(
    `insert into article_revisions (
       id, workspace_id, article_id, revision_number, category_id, category_slug,
       category_name, slug, title, mdx, is_faq, author_name, position,
       revision_hash, change_kind, created_by_member_id, created_by_system_label,
       change_summary, created_at, restored_from_revision_id
     ) values ($1, $2, $3, 1, $4, 'guides', 'Guides', $5, $6, $7, false,
               'OPAS', 0, $8, 'manual', $9, null, null, $10, null)`,
    [
      fixture.revisionId,
      fixture.workspaceId,
      fixture.articleId,
      fixture.categoryId,
      fixture.article.slug,
      fixture.article.title,
      fixture.article.mdx,
      baseline.revisionHash,
      fixture.memberId,
      new Date(fixedTime),
    ],
  );
  await pool.query(
    `insert into article_slug_claims
       (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
     values ($1, $2, $3, true, true)`,
    [fixture.workspaceId, fixture.article.slug, fixture.articleId],
  );
  await pool.query(
    `insert into article_heads (
       article_id, workspace_id, working_revision_id, working_revision_number,
       working_slug, published_revision_id, published_revision_number,
       review_state, submitted_by_member_id, archived_at, archived_by_member_id
     ) values ($1, $2, $3, 1, $4, null, null, 'editing', null, null, null)`,
    [
      fixture.articleId,
      fixture.workspaceId,
      fixture.revisionId,
      fixture.article.slug,
    ],
  );

  if (state === "missing-head") {
    await pool.query("delete from article_heads where article_id = $1", [fixture.articleId]);
  } else if (state === "missing-revision") {
    await pool.query("alter table article_revisions disable trigger all");
    try {
      await pool.query("delete from article_revisions where id = $1", [fixture.revisionId]);
    } finally {
      await pool.query("alter table article_revisions enable trigger all");
    }
  } else if (state === "missing-working-claim") {
    await pool.query(
      `update article_slug_claims set working_claim = false
       where workspace_id = $1 and normalized_slug = $2`,
      [fixture.workspaceId, fixture.article.slug],
    );
  }
  await pool.query(
    `update workspace_authoring_controls
     set writes_paused = true, generation = generation + 1, changed_at = $1
     where workspace_id = $2`,
    [new Date(fixedTime + 1), fixture.workspaceId],
  );
  return fixture;
}

test(
  "Postgres installs guards after a completed empty ledger gains revision-aware content",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await applyPostgresBeforeTeamAuthoring(pool);
      await applyPostgresTeamAuthoringSchema(pool);
      await seedPostgresCompletedRevisionAwareWorkspace(pool, "complete", "complete");
      const store = createPostgresTeamAuthoringBackfillStore(pool);

      assert.deepEqual(await store.assertAllWorkspacesPaused(), {
        completedWorkspaceIds: ["workspace_complete"],
        guardsInstalled: false,
        pendingArticleCount: 0,
        workspaceIds: ["workspace_complete"],
      });
      const result = await runTeamAuthoringBackfill(store);
      assert.equal(result.alreadyCompleted, false);
      assert.equal(result.articleCount, 0);
      assert.equal(result.chunkCount, 0);
      assert.deepEqual(
        (await pool.query("select id, change_kind from article_revisions")).rows,
        [{ change_kind: "manual", id: "revision_complete" }],
      );
      assert.equal((await store.assertAllWorkspacesPaused()).guardsInstalled, true);
      assert.equal((await runTeamAuthoringBackfill(store)).alreadyCompleted, true);
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);

test(
  "Postgres rejects completed ledgers with incomplete revision-aware content",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await applyPostgresBeforeTeamAuthoring(pool);
      await applyPostgresTeamAuthoringSchema(pool);
      await seedPostgresCompletedRevisionAwareWorkspace(pool, "missing-head", "missing-head");
      await seedPostgresCompletedRevisionAwareWorkspace(
        pool,
        "missing-revision",
        "missing-revision",
      );
      await seedPostgresCompletedRevisionAwareWorkspace(
        pool,
        "missing-working-claim",
        "missing-working-claim",
      );
      const store = createPostgresTeamAuthoringBackfillStore(pool);

      assert.equal((await store.assertAllWorkspacesPaused()).pendingArticleCount, 3);
      await assert.rejects(
        runTeamAuthoringBackfill(store),
        /AUTHORING_BACKFILL_LEDGER_PARTIAL/u,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              `select count(*) as count from pg_trigger
               where tgname = 'article_heads_authoring_control_trigger' and not tgisinternal`,
            )
          ).rows[0].count,
        ),
        0,
      );
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);

test(
  "Postgres backfill preserves microsecond timestamps and resumes deterministically",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await applyPostgresBeforeTeamAuthoring(pool);
      await pool.query(
        `insert into workspaces (id, slug, name) values ('workspace_pg', 'pg', 'Postgres');
         insert into categories (id, workspace_id, slug, name)
           values ('category_pg', 'workspace_pg', 'guides', 'Guides');`,
      );
      for (let index = 0; index < 26; index += 1) {
        await pool.query(
          `insert into articles (
             id, workspace_id, category_id, slug, title, mdx, status, is_faq,
             author_name, position, created_at, updated_at
           ) values ($1, 'workspace_pg', 'category_pg', $2, $3, $4, $5, false,
                     'OPAS', $6, '2026-09-03T10:00:00.123456Z',
                     '2026-09-03T10:00:00.123456Z')`,
          [
            `article_${String(index).padStart(3, "0")}`,
            `article-${index}`,
            `Article ${index}`,
            `# Article ${index}`,
            index % 2 === 0 ? "published" : "draft",
            index,
          ],
        );
      }
      const before = await pool.query("select * from articles order by id");
      await pool.query(
        "update workspace_authoring_controls set writes_paused = true, generation = generation + 1 where workspace_id = 'workspace_pg'",
      );
      await applyPostgresTeamAuthoringSchema(pool);
      const store = createPostgresTeamAuthoringBackfillStore(pool);
      await assert.rejects(
        runTeamAuthoringBackfill(store, { interruptAfterChunks: 1 }),
        /AUTHORING_BACKFILL_INTERRUPTED/u,
      );
      const result = await runTeamAuthoringBackfill(store);
      assert.equal(result.articleCount, 26);
      assert.equal(result.chunkCount, 2);
      assert.deepEqual((await pool.query("select * from articles order by id")).rows, before.rows);
      assert.equal(
        Number(
          (
            await pool.query(
              `select count(*) as count
               from article_revisions revision
               inner join articles article
                 on article.id = revision.article_id
                 and article.workspace_id = revision.workspace_id
               where revision.created_at = article.updated_at`,
            )
          ).rows[0].count,
        ),
        26,
      );
      assert.equal((await runTeamAuthoringBackfill(store)).alreadyCompleted, true);
      await assert.rejects(
        pool.query(
          `insert into article_slug_claims
             (workspace_id, normalized_slug, article_id, working_claim, article_row_claim)
           values ('workspace_pg', 'paused', 'article_000', true, false)`,
        ),
        /AUTHORING_PAUSED/u,
      );
      await pool.query(
        "update workspace_authoring_controls set writes_paused = false, generation = generation + 1 where workspace_id = 'workspace_pg'",
      );
      await assert.rejects(
        pool.query("update article_revisions set title = 'Changed' where article_id = 'article_000'"),
        /ARTICLE_REVISION_IMMUTABLE/u,
      );
      await assert.rejects(
        pool.query(
          `insert into article_revisions (
             id, workspace_id, article_id, revision_number, category_id,
             category_slug, category_name, slug, title, mdx, is_faq,
             author_name, position, revision_hash, change_kind,
             created_by_member_id, created_by_system_label, created_at
           )
           select 'revision_missing_actor', workspace_id, article_id, 99,
             category_id, category_slug, category_name, slug, title, mdx, is_faq,
             author_name, position, $1, 'migration', null, null, now()
           from article_revisions where article_id = 'article_001' and revision_number = 1`,
          ["c".repeat(64)],
        ),
        /article_revisions_actor_check/u,
      );
      await assert.rejects(
        pool.query(
          "update article_heads set working_slug = 'mismatch' where article_id = 'article_000'",
        ),
        /ARTICLE_HEAD_INVALID/u,
      );
      await assert.rejects(
        pool.query(
          "update article_heads set working_revision_number = 2 where article_id = 'article_001'",
        ),
        /ARTICLE_HEAD_INVALID|violates foreign key constraint/u,
      );
      await assert.rejects(
        pool.query(
          "update article_heads set archived_at = now() where article_id = 'article_000'",
        ),
        /ARTICLE_HEAD_INVALID/u,
      );
      await assert.rejects(
        pool.query(
          "update article_heads set review_state = 'invalid' where article_id = 'article_001'",
        ),
        /article_heads_review_state_check/u,
      );
      await assert.rejects(
        pool.query(
          `insert into articles (
             id, workspace_id, category_id, slug, title, mdx, status, is_faq,
             author_name, position, created_at, updated_at
           ) values (
             'article_headless', 'workspace_pg', 'category_pg', 'headless',
             'Headless', '# Headless', 'published', false, 'OPAS', 0, now(), now()
           )`,
        ),
        /ARTICLE_MATERIALIZATION_INVALID/u,
      );
      await assert.rejects(
        pool.query("delete from articles where id = 'article_000'"),
        /ARTICLE_DELETE_FORBIDDEN/u,
      );
      assert.deepEqual((await pool.query("select * from articles order by id")).rows, before.rows);
      assert.equal((await pool.query("select * from article_heads")).rowCount, 26);
      assert.equal(
        Number(
          (
            await pool.query(
              "select count(*) from pg_constraint where contype = 'f' and not convalidated",
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_pg"),
        "complete",
      );
      await pool.query(
        `alter trigger article_heads_authoring_control_trigger on article_heads
           rename to article_heads_authoring_control_trigger_missing;
         create function opas_test_wrong_relation_trigger()
         returns trigger language plpgsql as $$ begin return new; end $$;
         create trigger article_heads_authoring_control_trigger
           before insert on articles
           for each row execute function opas_test_wrong_relation_trigger();`,
      );
      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_pg"),
        "incomplete",
      );
      await pool.query(
        `drop trigger article_heads_authoring_control_trigger on articles;
         alter trigger article_heads_authoring_control_trigger_missing on article_heads
           rename to article_heads_authoring_control_trigger;
         drop function opas_test_wrong_relation_trigger();`,
      );
      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_pg"),
        "complete",
      );
      await pool.query(
        "alter table article_heads disable trigger article_heads_authoring_control_trigger",
      );
      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_pg"),
        "incomplete",
      );
      await pool.query(
        "alter table article_heads enable trigger article_heads_authoring_control_trigger",
      );
      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_pg"),
        "complete",
      );
      await pool.query(
        "update workspace_authoring_controls set writes_paused = false, generation = generation + 1 where workspace_id = 'workspace_pg'",
      );
      await pool.query("delete from workspaces where id = 'workspace_pg'");
      assert.equal((await pool.query("select * from article_revisions")).rowCount, 0);
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);

test(
  "Postgres clean install records a zero-article bootstrap ledger",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await applyPostgresBeforeTeamAuthoring(pool);
      await applyPostgresTeamAuthoringSchema(pool);
      const store = createPostgresTeamAuthoringBackfillStore(pool);
      const fresh = await runTeamAuthoringBackfill(store, {
        clock: () => new Date(fixedTime),
      });
      assert.equal(fresh.articleCount, 0);

      const bootstrap = await pool.connect();
      try {
        await bootstrap.query("begin");
        await bootstrap.query(
          `insert into workspaces (id, slug, name, created_at, updated_at)
           values ('workspace_clean', 'clean', 'Clean', $1, $1)`,
          [new Date(fixedTime)],
        );
        await bootstrap.query(
          `update workspace_authoring_controls
           set writes_paused = true, generation = generation + 1, changed_at = $1
           where workspace_id = 'workspace_clean'`,
          [new Date(fixedTime + 1)],
        );
        await bootstrap.query("savepoint invalid_member");
        await assert.rejects(
          bootstrap.query(
            `insert into workspace_members (
               id, workspace_id, normalized_email, display_name, role, status,
               password_salt, password_digest, password_iterations,
               created_by_member_id, created_at, updated_at
             ) values (
               'member_invalid', 'workspace_clean', 'invalid@clean.test', 'Invalid',
               'administrator', 'disabled', $1, $2, 600000, null, $3, $3
             )`,
            ["A".repeat(43), "a".repeat(43), new Date(fixedTime)],
          ),
          /MEMBER_BOOTSTRAP_INVALID/u,
        );
        await bootstrap.query("rollback to savepoint invalid_member");
        await bootstrap.query(
          `insert into workspace_members (
             id, workspace_id, normalized_email, display_name, role, status,
             password_salt, password_digest, password_iterations,
             created_by_member_id, created_at, updated_at
           ) values (
             'member_clean', 'workspace_clean', 'admin@clean.test', 'Admin',
             'administrator', 'active', $1, $2, 600000, null, $3, $3
           )`,
          ["A".repeat(43), "a".repeat(43), new Date(fixedTime)],
        );
        await bootstrap.query("commit");
      } catch (error) {
        await bootstrap.query("rollback");
        throw error;
      } finally {
        bootstrap.release();
      }

      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_clean"),
        "incomplete",
      );
      const completed = await runTeamAuthoringBackfill(store, {
        clock: () => new Date(fixedTime + 2),
      });
      assert.equal(completed.articleCount, 0);
      assert.equal(completed.alreadyCompleted, false);
      assert.deepEqual(
        (
          await pool.query(
            `select article_count, version
             from workspace_authoring_migrations
             where workspace_id = 'workspace_clean'`,
          )
        ).rows,
        [{ article_count: 0, version: 1 }],
      );
      assert.equal(
        await readPostgresAuthoringBackfillState(postgresRows(pool), "workspace_clean"),
        "complete",
      );
      assert.equal((await runTeamAuthoringBackfill(store)).alreadyCompleted, true);
      assert.equal(
        Number(
          (
            await pool.query(
              "select count(*) from pg_constraint where contype = 'f' and not convalidated",
            )
          ).rows[0].count,
        ),
        0,
      );
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);

test(
  "Postgres Phase 16.3 DDL is atomic for unpaused and missing controls",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      await applyPostgresBeforeTeamAuthoring(pool);
      await pool.query(
        "insert into workspaces (id, slug, name) values ('unsafe', 'unsafe', 'Unsafe')",
      );
      await assert.rejects(
        applyPostgresTeamAuthoringSchema(pool),
        /AUTHORING_MIGRATION_REQUIRES_PAUSE/u,
      );
      assert.equal(
        (await pool.query("select to_regclass('public.workspace_members') as table_name"))
          .rows[0].table_name,
        null,
      );

      await pool.query(
        "delete from workspace_authoring_controls where workspace_id = 'unsafe'",
      );
      await assert.rejects(
        applyPostgresTeamAuthoringSchema(pool),
        /AUTHORING_MIGRATION_REQUIRES_PAUSE/u,
      );
      assert.equal(
        (await pool.query("select to_regclass('public.workspace_members') as table_name"))
          .rows[0].table_name,
        null,
      );
    } finally {
      await pool.end();
      await container.stop();
    }
  },
);
