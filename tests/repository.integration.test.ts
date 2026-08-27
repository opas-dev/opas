// ABOUTME: Runs one repository contract against migrated Postgres and local SQLite databases.
// ABOUTME: Verifies schema parity, deterministic seeds, constraints, reads, writes, and cascades.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { demoContent, demoIds, demoSeededAt } from "@/db/demo";
import { createPostgresRepository } from "@/db/postgres/repository";
import { seedPostgres } from "@/db/postgres/seed";
import type { Repository } from "@/db/repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteRepository } from "@/db/sqlite/repository";
import { seedD1 } from "@/db/sqlite/seed";

const expectedColumns = {
  article_feedback: ["id", "article_id", "helpful", "comment", "created_at"],
  article_views: ["id", "article_id", "viewed_at"],
  articles: [
    "id",
    "workspace_id",
    "category_id",
    "slug",
    "title",
    "mdx",
    "status",
    "is_faq",
    "author_name",
    "published_at",
    "created_at",
    "updated_at",
  ],
  categories: [
    "id",
    "workspace_id",
    "slug",
    "name",
    "description",
    "position",
    "created_at",
    "updated_at",
  ],
  search_misses: ["id", "workspace_id", "query", "created_at"],
  themes: ["id", "workspace_id", "name", "config", "created_at", "updated_at"],
  workspaces: ["id", "slug", "name", "created_at", "updated_at"],
} as const;

type TableName = keyof typeof expectedColumns;
type RuleViolation =
  | "duplicateWorkspaceSlug"
  | "duplicateCategorySlug"
  | "duplicateArticleSlug"
  | "duplicateWorkspaceTheme"
  | "orphanFeedback"
  | "orphanSearchMiss"
  | "invalidArticleStatus";

type Harness = {
  name: string;
  repository: Repository;
  seed(): Promise<void>;
  deploymentSeed?(): Promise<void>;
  columns(): Promise<Record<TableName, string[]>>;
  counts(): Promise<Record<TableName, number>>;
  feedback(id: string): Promise<{ helpful: boolean; comment: string | null } | null>;
  relatedArticleRecords(articleId: string): Promise<{ feedback: number; views: number }>;
  searchMissCount(id: string): Promise<number>;
  violate(rule: RuleViolation): Promise<void>;
  deleteArticle(id: string): Promise<void>;
  close(): Promise<void>;
};

const tableNames = Object.keys(expectedColumns) as TableName[];

async function exerciseRepository(harness: Harness) {
  await harness.seed();
  await harness.seed();

  assert.deepEqual(await harness.columns(), expectedColumns, `${harness.name} schema drifted`);
  assert.deepEqual(await harness.counts(), {
    article_feedback: 0,
    article_views: 0,
    articles: 2,
    categories: 2,
    search_misses: 0,
    themes: 1,
    workspaces: 1,
  });

  if (harness.deploymentSeed) {
    await harness.deploymentSeed();
    await harness.deploymentSeed();
    assert.deepEqual(await harness.counts(), {
      article_feedback: 0,
      article_views: 0,
      articles: 2,
      categories: 2,
      search_misses: 0,
      themes: 1,
      workspaces: 1,
    });
  }

  await harness.repository.checkHealth();

  const published = await harness.repository.findPublishedArticle(
    demoIds.workspace,
    demoContent.articles[0].slug,
  );
  assert.ok(published);
  assert.equal(published.id, demoIds.publishedArticle);
  assert.equal(published.isFaq, false);
  assert.ok(published.publishedAt instanceof Date);
  assert.ok(published.createdAt instanceof Date);
  assert.ok(published.updatedAt instanceof Date);
  assert.equal(published.publishedAt.toISOString(), demoSeededAt);
  assert.equal(published.createdAt.toISOString(), demoSeededAt);
  assert.equal(published.updatedAt.toISOString(), demoSeededAt);

  assert.equal(
    await harness.repository.findPublishedArticle(
      demoIds.workspace,
      demoContent.articles[1].slug,
    ),
    null,
    `${harness.name} exposed a draft article`,
  );
  assert.equal(
    await harness.repository.findPublishedArticle(demoIds.workspace, "missing-article"),
    null,
  );

  const categories = await harness.repository.listCategories(demoIds.workspace);
  assert.deepEqual(
    categories,
    demoContent.categories.map((category) => ({
      id: category.id,
      workspaceId: category.workspaceId,
      slug: category.slug,
      name: category.name,
      description: category.description,
      position: category.position,
    })),
  );

  const theme = await harness.repository.getTheme(demoIds.workspace);
  assert.ok(theme);
  assert.equal(theme.id, demoIds.theme);
  assert.equal(theme.name, demoContent.theme.name);
  assert.deepEqual(theme.config, demoContent.theme.config);
  assert.ok(theme.createdAt instanceof Date);
  assert.ok(theme.updatedAt instanceof Date);
  assert.equal(theme.createdAt.toISOString(), demoSeededAt);
  assert.equal(theme.updatedAt.toISOString(), demoSeededAt);

  const updatedThemeConfig = {
    ...demoContent.theme.config,
    light: {
      ...demoContent.theme.config.light,
      primary: "oklch(0.55 0.18 250)",
    },
  };
  await harness.repository.updateTheme({
    workspaceId: demoIds.workspace,
    name: "Contract Theme",
    config: updatedThemeConfig,
  });

  const updatedTheme = await harness.repository.getTheme(demoIds.workspace);
  assert.ok(updatedTheme);
  assert.equal(updatedTheme.id, demoIds.theme);
  assert.equal(updatedTheme.workspaceId, demoIds.workspace);
  assert.equal(updatedTheme.name, "Contract Theme");
  assert.deepEqual(updatedTheme.config, updatedThemeConfig);
  assert.equal(updatedTheme.createdAt.toISOString(), demoSeededAt);
  assert.ok(updatedTheme.updatedAt.getTime() > new Date(demoSeededAt).getTime());

  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: true,
    comment: "Clear and useful",
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_contract",
    workspaceId: demoIds.workspace,
    query: "billing portal",
  });

  assert.deepEqual(await harness.feedback("feedback_contract"), {
    helpful: true,
    comment: "Clear and useful",
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 1,
    views: 1,
  });
  assert.equal(await harness.searchMissCount("search_miss_contract"), 1);

  const violations: RuleViolation[] = [
    "duplicateWorkspaceSlug",
    "duplicateCategorySlug",
    "duplicateArticleSlug",
    "duplicateWorkspaceTheme",
    "orphanFeedback",
    "orphanSearchMiss",
    "invalidArticleStatus",
  ];
  for (const violation of violations) {
    await assert.rejects(
      harness.violate(violation),
      `${harness.name} accepted ${violation}`,
    );
  }

  await harness.deleteArticle(demoIds.publishedArticle);
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 0,
    views: 0,
  });
}

async function createPostgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });

  try {
    await migratePostgres(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
    });
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }

  return {
    name: "Postgres",
    repository: createPostgresRepository(database),
    seed: () => seedPostgres(database),
    async columns() {
      const result = await pool.query<{ table_name: TableName; column_name: string }>(
        `select table_name, column_name
         from information_schema.columns
         where table_schema = 'public' and table_name = any($1::text[])
         order by table_name, ordinal_position`,
        [tableNames],
      );
      const columns = tableNames.reduce<Record<TableName, string[]>>((result, table) => {
        result[table] = [];
        return result;
      }, {} as Record<TableName, string[]>);
      for (const row of result.rows) {
        columns[row.table_name].push(row.column_name);
      }
      return columns;
    },
    async counts() {
      const entries = await Promise.all(
        tableNames.map(async (table) => {
          const result = await pool.query<{ count: string }>(`select count(*) from ${table}`);
          return [table, Number(result.rows[0].count)] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<TableName, number>;
    },
    async feedback(id) {
      const result = await pool.query<{ helpful: boolean; comment: string | null }>(
        "select helpful, comment from article_feedback where id = $1",
        [id],
      );
      return result.rows[0] ?? null;
    },
    async relatedArticleRecords(articleId) {
      const [feedback, views] = await Promise.all([
        pool.query<{ count: string }>(
          "select count(*) from article_feedback where article_id = $1",
          [articleId],
        ),
        pool.query<{ count: string }>("select count(*) from article_views where article_id = $1", [
          articleId,
        ]),
      ]);
      return {
        feedback: Number(feedback.rows[0].count),
        views: Number(views.rows[0].count),
      };
    },
    async searchMissCount(id) {
      const result = await pool.query<{ count: string }>(
        "select count(*) from search_misses where id = $1",
        [id],
      );
      return Number(result.rows[0].count);
    },
    async violate(rule) {
      const statements: Record<RuleViolation, [string, unknown[]]> = {
        duplicateWorkspaceSlug: [
          "insert into workspaces (id, slug, name) values ($1, $2, $3)",
          ["workspace_duplicate", demoContent.workspace.slug, "Duplicate"],
        ],
        duplicateCategorySlug: [
          "insert into categories (id, workspace_id, slug, name) values ($1, $2, $3, $4)",
          [
            "category_duplicate",
            demoIds.workspace,
            demoContent.categories[0].slug,
            "Duplicate",
          ],
        ],
        duplicateArticleSlug: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            "article_duplicate",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            demoContent.articles[0].slug,
            "Duplicate",
            "# Duplicate",
          ],
        ],
        duplicateWorkspaceTheme: [
          "insert into themes (id, workspace_id, name, config) values ($1, $2, $3, $4::jsonb)",
          ["theme_duplicate", demoIds.workspace, "Duplicate", "{}"],
        ],
        orphanFeedback: [
          "insert into article_feedback (id, article_id, helpful) values ($1, $2, $3)",
          ["feedback_orphan", "article_missing", true],
        ],
        orphanSearchMiss: [
          "insert into search_misses (id, workspace_id, query) values ($1, $2, $3)",
          ["search_miss_orphan", "workspace_missing", "missing"],
        ],
        invalidArticleStatus: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx, status)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            "article_invalid_status",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            "invalid-status",
            "Invalid",
            "# Invalid",
            "archived",
          ],
        ],
      };
      const [statement, parameters] = statements[rule];
      await pool.query(statement, parameters);
    },
    async deleteArticle(id) {
      await pool.query("delete from articles where id = $1", [id]);
    },
    async close() {
      await pool.end();
      await container.stop();
    },
  };
}

async function createLocalSqliteHarness(): Promise<Harness> {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });

  try {
    migrateSqlite(database, {
      migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
    });
    assert.equal(client.pragma("foreign_keys", { simple: true }), 1);
  } catch (error) {
    client.close();
    throw error;
  }

  return {
    name: "SQLite",
    repository: createSqliteRepository(database),
    seed: () => seedD1(database),
    async deploymentSeed() {
      client.exec(readFileSync(path.join(process.cwd(), "scripts/seed-d1.sql"), "utf8"));
    },
    async columns() {
      const entries = tableNames.map((table) => {
        const rows = client.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
        return [table, rows.map((row) => row.name)] as const;
      });
      return Object.fromEntries(entries) as Record<TableName, string[]>;
    },
    async counts() {
      const entries = tableNames.map((table) => {
        const row = client.prepare(`select count(*) as count from ${table}`).get() as {
          count: number;
        };
        return [table, row.count] as const;
      });
      return Object.fromEntries(entries) as Record<TableName, number>;
    },
    async feedback(id) {
      const row = client
        .prepare("select helpful, comment from article_feedback where id = ?")
        .get(id) as { helpful: number; comment: string | null } | undefined;
      return row ? { helpful: row.helpful === 1, comment: row.comment } : null;
    },
    async relatedArticleRecords(articleId) {
      const feedback = client
        .prepare("select count(*) as count from article_feedback where article_id = ?")
        .get(articleId) as { count: number };
      const views = client
        .prepare("select count(*) as count from article_views where article_id = ?")
        .get(articleId) as { count: number };
      return { feedback: feedback.count, views: views.count };
    },
    async searchMissCount(id) {
      const row = client.prepare("select count(*) as count from search_misses where id = ?").get(id) as {
        count: number;
      };
      return row.count;
    },
    async violate(rule) {
      const statements: Record<RuleViolation, [string, unknown[]]> = {
        duplicateWorkspaceSlug: [
          "insert into workspaces (id, slug, name) values (?, ?, ?)",
          ["workspace_duplicate", demoContent.workspace.slug, "Duplicate"],
        ],
        duplicateCategorySlug: [
          "insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)",
          [
            "category_duplicate",
            demoIds.workspace,
            demoContent.categories[0].slug,
            "Duplicate",
          ],
        ],
        duplicateArticleSlug: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx)
           values (?, ?, ?, ?, ?, ?)`,
          [
            "article_duplicate",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            demoContent.articles[0].slug,
            "Duplicate",
            "# Duplicate",
          ],
        ],
        duplicateWorkspaceTheme: [
          "insert into themes (id, workspace_id, name, config) values (?, ?, ?, ?)",
          ["theme_duplicate", demoIds.workspace, "Duplicate", "{}"],
        ],
        orphanFeedback: [
          "insert into article_feedback (id, article_id, helpful) values (?, ?, ?)",
          ["feedback_orphan", "article_missing", 1],
        ],
        orphanSearchMiss: [
          "insert into search_misses (id, workspace_id, query) values (?, ?, ?)",
          ["search_miss_orphan", "workspace_missing", "missing"],
        ],
        invalidArticleStatus: [
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx, status)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [
            "article_invalid_status",
            demoIds.workspace,
            demoIds.gettingStartedCategory,
            "invalid-status",
            "Invalid",
            "# Invalid",
            "archived",
          ],
        ],
      };
      const [statement, parameters] = statements[rule];
      client.prepare(statement).run(...parameters);
    },
    async deleteArticle(id) {
      client.prepare("delete from articles where id = ?").run(id);
    },
    async close() {
      client.close();
    },
  };
}

test("repository contract passes on Postgres", { timeout: 120_000 }, async () => {
  const harness = await createPostgresHarness();
  try {
    await exerciseRepository(harness);
  } finally {
    await harness.close();
  }
});

test("repository contract passes on local SQLite", async () => {
  const harness = await createLocalSqliteHarness();
  try {
    await exerciseRepository(harness);
  } finally {
    await harness.close();
  }
});

test("SQLite article constraint migration preserves feedback and views", () => {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");

  try {
    const migrationDirectory = path.join(process.cwd(), "drizzle/sqlite");
    client.transaction(() => {
      client.exec(readFileSync(path.join(migrationDirectory, "0000_cool_gertrude_yorkes.sql"), "utf8"));
    })();
    client
      .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
      .run(demoIds.workspace, demoContent.workspace.slug, demoContent.workspace.name);
    client
      .prepare("insert into categories (id, workspace_id, slug, name) values (?, ?, ?, ?)")
      .run(
        demoIds.gettingStartedCategory,
        demoIds.workspace,
        demoContent.categories[0].slug,
        demoContent.categories[0].name,
      );
    client
      .prepare(
        `insert into articles
           (id, workspace_id, category_id, slug, title, mdx, status)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        demoIds.publishedArticle,
        demoIds.workspace,
        demoIds.gettingStartedCategory,
        demoContent.articles[0].slug,
        demoContent.articles[0].title,
        demoContent.articles[0].mdx,
        demoContent.articles[0].status,
      );
    client
      .prepare("insert into article_feedback (id, article_id, helpful) values (?, ?, ?)")
      .run("feedback_before_upgrade", demoIds.publishedArticle, 1);
    client
      .prepare("insert into article_views (id, article_id) values (?, ?)")
      .run("view_before_upgrade", demoIds.publishedArticle);

    client.transaction(() => {
      client.exec(
        readFileSync(path.join(migrationDirectory, "0001_opposite_centennial.sql"), "utf8"),
      );
    })();

    assert.equal(
      (client.prepare("select count(*) as count from article_feedback").get() as { count: number })
        .count,
      1,
    );
    assert.equal(
      (client.prepare("select count(*) as count from article_views").get() as { count: number })
        .count,
      1,
    );
    assert.deepEqual(client.pragma("foreign_key_check"), []);
    assert.throws(() => {
      client
        .prepare(
          `insert into articles
             (id, workspace_id, category_id, slug, title, mdx, status)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "article_invalid_after_upgrade",
          demoIds.workspace,
          demoIds.gettingStartedCategory,
          "invalid-after-upgrade",
          "Invalid",
          "# Invalid",
          "archived",
        );
    });
  } finally {
    client.close();
  }
});
