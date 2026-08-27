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
  createWorkspace(workspace: { id: string; slug: string; name: string }): Promise<void>;
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
const dayInMilliseconds = 86_400_000;

async function recordSearchSamples(
  repository: Repository,
  workspaceId: string,
  query: string,
  count: number,
  createdAt: Date,
) {
  for (let index = 0; index < count; index += 1) {
    await repository.recordSearchMiss({
      id: `analytics_miss_${workspaceId}_${query}_${index}`,
      workspaceId,
      query,
      createdAt,
    });
  }
}

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

  const publishedArticles = await harness.repository.listPublishedArticles(demoIds.workspace);
  assert.equal(publishedArticles.length, 1, `${harness.name} included drafts in public listings`);
  assert.equal(publishedArticles[0].id, demoIds.publishedArticle);

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

  const contractCategory = {
    id: "category_contract",
    workspaceId: demoIds.workspace,
    slug: "contract",
    name: "Contract",
    description: null,
    position: 1,
  };
  await harness.repository.createCategory(contractCategory);
  assert.deepEqual(
    (await harness.repository.listCategories(demoIds.workspace)).map((category) => category.id),
    [
      demoIds.gettingStartedCategory,
      contractCategory.id,
      demoIds.customizationCategory,
    ],
    `${harness.name} did not order equal-position categories by id`,
  );

  await harness.repository.updateCategory({
    ...contractCategory,
    name: "Repository contract",
    description: "Cross-dialect CRUD",
    position: -1,
  });
  assert.deepEqual((await harness.repository.listCategories(demoIds.workspace))[0], {
    ...contractCategory,
    name: "Repository contract",
    description: "Cross-dialect CRUD",
    position: -1,
  });

  assert.equal(
    await harness.repository.deleteCategory(
      demoIds.workspace,
      demoIds.gettingStartedCategory,
    ),
    false,
    `${harness.name} deleted a category that still contained articles`,
  );

  await harness.repository.updateCategory({
    ...contractCategory,
    workspaceId: "workspace_missing",
    name: "Wrong workspace",
  });
  assert.equal(
    (await harness.repository.listCategories(demoIds.workspace))[0].name,
    "Repository contract",
    `${harness.name} updated a category outside the requested workspace`,
  );

  const contractArticle = {
    id: "article_contract",
    workspaceId: demoIds.workspace,
    categoryId: contractCategory.id,
    slug: "repository-contract",
    title: "Repository contract",
    mdx: "# Repository contract",
    status: "draft" as const,
    isFaq: true,
    authorName: "Contract author",
    publishedAt: null,
  };
  await harness.repository.createArticle(contractArticle);

  const createdArticle = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(createdArticle);
  const {
    createdAt: contractCreatedAt,
    updatedAt: contractUpdatedAt,
    ...createdArticleSubmission
  } = createdArticle;
  assert.deepEqual(createdArticleSubmission, contractArticle);
  assert.ok(contractCreatedAt instanceof Date);
  assert.ok(contractUpdatedAt instanceof Date);
  assert.equal(
    await harness.repository.findPublishedArticle(demoIds.workspace, contractArticle.slug),
    null,
    `${harness.name} exposed an admin-created draft`,
  );

  const contractPublishedAt = new Date("2026-02-03T04:05:06.000Z");
  await harness.repository.updateArticle({
    ...contractArticle,
    title: "Published repository contract",
    status: "published",
    publishedAt: contractPublishedAt,
  });

  const updatedArticle = await harness.repository.getArticle(
    demoIds.workspace,
    contractArticle.id,
  );
  assert.ok(updatedArticle);
  assert.equal(updatedArticle.status, "published");
  assert.equal(updatedArticle.title, "Published repository contract");
  assert.equal(updatedArticle.publishedAt?.toISOString(), contractPublishedAt.toISOString());
  assert.equal(updatedArticle.createdAt.toISOString(), contractCreatedAt.toISOString());
  assert.ok(updatedArticle.updatedAt.getTime() >= contractUpdatedAt.getTime());
  assert.ok(
    (await harness.repository.listPublishedArticles(demoIds.workspace)).some(
      (article) => article.id === contractArticle.id,
    ),
    `${harness.name} omitted a newly published article from the public listing`,
  );

  const listedArticles = await harness.repository.listArticles(demoIds.workspace);
  assert.deepEqual(
    listedArticles.map((article) => [article.title, article.status]),
    [
      [demoContent.articles[1].title, "draft"],
      ["Published repository contract", "published"],
      [demoContent.articles[0].title, "published"],
    ],
  );

  await harness.repository.updateArticle({
    ...contractArticle,
    workspaceId: "workspace_missing",
    title: "Wrong workspace",
  });
  assert.equal(
    (await harness.repository.getArticle(demoIds.workspace, contractArticle.id))?.title,
    "Published repository contract",
    `${harness.name} updated an article outside the requested workspace`,
  );

  await harness.repository.deleteArticle("workspace_missing", contractArticle.id);
  assert.ok(await harness.repository.getArticle(demoIds.workspace, contractArticle.id));
  await harness.repository.deleteArticle(demoIds.workspace, contractArticle.id);
  assert.equal(
    await harness.repository.getArticle(demoIds.workspace, contractArticle.id),
    null,
  );
  assert.ok(
    !(await harness.repository.listPublishedArticles(demoIds.workspace)).some(
      (article) => article.id === contractArticle.id,
    ),
    `${harness.name} retained a deleted article in the public listing`,
  );

  assert.equal(
    await harness.repository.deleteCategory("workspace_missing", contractCategory.id),
    false,
  );
  assert.ok(
    (await harness.repository.listCategories(demoIds.workspace)).some(
      (category) => category.id === contractCategory.id,
    ),
  );
  assert.equal(
    await harness.repository.deleteCategory(demoIds.workspace, contractCategory.id),
    true,
  );
  assert.ok(
    !(await harness.repository.listCategories(demoIds.workspace)).some(
      (category) => category.id === contractCategory.id,
    ),
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

  const contractEventAt = new Date();
  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: true,
    comment: "Clear and useful",
    createdAt: contractEventAt,
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
    viewedAt: contractEventAt,
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_contract",
    workspaceId: demoIds.workspace,
    query: "billing portal",
    createdAt: contractEventAt,
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

  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: false,
    comment: "Colliding slot",
    createdAt: contractEventAt,
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
    viewedAt: contractEventAt,
  });
  assert.deepEqual(await harness.feedback("feedback_contract"), {
    helpful: true,
    comment: "Clear and useful",
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 1,
    views: 1,
  });

  await harness.repository.createFeedback({
    id: "feedback_expired",
    articleId: demoIds.publishedArticle,
    helpful: false,
    comment: null,
    createdAt: new Date(contractEventAt.getTime() - 31 * dayInMilliseconds),
  });
  await harness.repository.recordView({
    id: "view_expired",
    articleId: demoIds.publishedArticle,
    viewedAt: new Date(contractEventAt.getTime() - 31 * dayInMilliseconds),
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 2,
    views: 2,
  });

  await harness.repository.createFeedback({
    id: "feedback_contract",
    articleId: demoIds.publishedArticle,
    helpful: false,
    comment: "Retention trigger",
    createdAt: contractEventAt,
  });
  await harness.repository.recordView({
    id: "view_contract",
    articleId: demoIds.publishedArticle,
    viewedAt: contractEventAt,
  });
  assert.deepEqual(await harness.feedback("feedback_contract"), {
    helpful: true,
    comment: "Clear and useful",
  });
  assert.deepEqual(await harness.relatedArticleRecords(demoIds.publishedArticle), {
    feedback: 1,
    views: 1,
  });

  await harness.repository.recordSearchMiss({
    id: "search_miss_expired",
    workspaceId: demoIds.workspace,
    query: "expired query",
    createdAt: new Date(contractEventAt.getTime() - 31 * dayInMilliseconds),
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_retention_trigger",
    workspaceId: demoIds.workspace,
    query: "current query",
    createdAt: contractEventAt,
  });
  await harness.repository.recordSearchMiss({
    id: "search_miss_retention_trigger",
    workspaceId: demoIds.workspace,
    query: "colliding slot",
    createdAt: contractEventAt,
  });
  assert.equal(await harness.searchMissCount("search_miss_expired"), 0);
  assert.equal(await harness.searchMissCount("search_miss_retention_trigger"), 1);

  const analyticsArticles = [
    {
      id: "article_analytics_alpha",
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "analytics-alpha",
      title: "Analytics tie",
      mdx: "# Analytics alpha",
      status: "published" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: new Date(),
    },
    {
      id: "article_analytics_alpha_b",
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "analytics-alpha-b",
      title: "Analytics tie",
      mdx: "# Analytics alpha B",
      status: "published" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: new Date(),
    },
    {
      id: "article_analytics_zulu",
      workspaceId: demoIds.workspace,
      categoryId: demoIds.customizationCategory,
      slug: "analytics-zulu",
      title: "Zulu analytics",
      mdx: "# Analytics zulu",
      status: "draft" as const,
      isFaq: false,
      authorName: "OPAS",
      publishedAt: null,
    },
  ];
  for (const article of analyticsArticles) {
    await harness.repository.createArticle(article);
  }

  const viewArticleIds = [
    demoIds.publishedArticle,
    demoIds.publishedArticle,
    "article_analytics_alpha",
    "article_analytics_alpha",
    "article_analytics_alpha_b",
    "article_analytics_alpha_b",
    "article_analytics_zulu",
    "article_analytics_zulu",
  ];
  const analyticsEventAt = new Date();
  for (const [index, articleId] of viewArticleIds.entries()) {
    await harness.repository.recordView({
      id: `analytics_view_${index}`,
      articleId,
      viewedAt: analyticsEventAt,
    });
  }

  const analyticsFeedback = [
    { id: "analytics_feedback_published_no", articleId: demoIds.publishedArticle, helpful: false },
    { id: "analytics_feedback_published_yes", articleId: demoIds.publishedArticle, helpful: true },
    { id: "analytics_feedback_alpha", articleId: "article_analytics_alpha", helpful: false },
    { id: "analytics_feedback_zulu_1", articleId: "article_analytics_zulu", helpful: true },
    { id: "analytics_feedback_zulu_2", articleId: "article_analytics_zulu", helpful: true },
    { id: "analytics_feedback_draft", articleId: demoIds.draftArticle, helpful: false },
  ];
  for (const feedback of analyticsFeedback) {
    await harness.repository.createFeedback({ ...feedback, createdAt: analyticsEventAt });
  }

  const expiredAnalyticsEventAt = new Date(Date.now() - 31 * dayInMilliseconds);
  await harness.repository.recordView({
    id: "analytics_view_expired",
    articleId: "article_analytics_alpha",
    viewedAt: expiredAnalyticsEventAt,
  });
  await harness.repository.createFeedback({
    id: "analytics_feedback_expired",
    articleId: "article_analytics_alpha",
    helpful: true,
    createdAt: expiredAnalyticsEventAt,
  });
  assert.deepEqual(await harness.relatedArticleRecords("article_analytics_alpha"), {
    feedback: 2,
    views: 3,
  });

  const isolationWorkspace = {
    id: "workspace_analytics_isolation",
    slug: "analytics-isolation",
    name: "Analytics isolation",
  };
  await harness.createWorkspace(isolationWorkspace);
  await harness.repository.createCategory({
    id: "category_analytics_isolation",
    workspaceId: isolationWorkspace.id,
    slug: "analytics",
    name: "Analytics",
    description: null,
    position: 0,
  });
  await harness.repository.createArticle({
    id: "article_analytics_isolation",
    workspaceId: isolationWorkspace.id,
    categoryId: "category_analytics_isolation",
    slug: "analytics",
    title: "Isolation article",
    mdx: "# Isolation",
    status: "published",
    isFaq: false,
    authorName: "OPAS",
    publishedAt: new Date(),
  });
  for (let index = 0; index < 5; index += 1) {
    await harness.repository.recordView({
      id: `analytics_isolation_view_${index}`,
      articleId: "article_analytics_isolation",
      viewedAt: analyticsEventAt,
    });
  }
  await harness.repository.createFeedback({
    id: "analytics_isolation_feedback",
    articleId: "article_analytics_isolation",
    helpful: true,
    createdAt: analyticsEventAt,
  });

  const recentSearchDate = new Date(Date.now() - 29 * dayInMilliseconds);
  const searchGroups = [
    ["alpha query", 4],
    ["beta query", 4],
    ["charlie query", 3],
    ["delta query", 3],
    ["echo query", 2],
    ["foxtrot query", 2],
    ["golf query", 2],
    ["hotel query", 2],
    ["india query", 2],
    ["juliet query", 2],
    ["kilo query", 1],
    ["lima query", 1],
  ] as const;
  for (const [query, count] of searchGroups) {
    await recordSearchSamples(
      harness.repository,
      demoIds.workspace,
      query,
      count,
      recentSearchDate,
    );
  }
  await recordSearchSamples(
    harness.repository,
    isolationWorkspace.id,
    "isolated query",
    5,
    recentSearchDate,
  );
  await recordSearchSamples(
    harness.repository,
    demoIds.workspace,
    "expired analytics query",
    6,
    new Date(Date.now() - 31 * dayInMilliseconds),
  );

  const analytics = await harness.repository.getAnalytics(demoIds.workspace);
  assert.deepEqual(analytics.articles, [
    {
      articleId: demoIds.publishedArticle,
      title: "Runtime MDX in OPAS",
      status: "published",
      views: 3,
      feedbackCount: 3,
      helpfulCount: 2,
    },
    {
      articleId: "article_analytics_alpha",
      title: "Analytics tie",
      status: "published",
      views: 2,
      feedbackCount: 1,
      helpfulCount: 0,
    },
    {
      articleId: "article_analytics_alpha_b",
      title: "Analytics tie",
      status: "published",
      views: 2,
      feedbackCount: 0,
      helpfulCount: 0,
    },
    {
      articleId: "article_analytics_zulu",
      title: "Zulu analytics",
      status: "draft",
      views: 2,
      feedbackCount: 2,
      helpfulCount: 2,
    },
    {
      articleId: demoIds.draftArticle,
      title: "Customize your help center",
      status: "draft",
      views: 0,
      feedbackCount: 1,
      helpfulCount: 0,
    },
  ]);
  assert.deepEqual(analytics.searchMisses, [
    { query: "alpha query", count: 4 },
    { query: "beta query", count: 4 },
    { query: "charlie query", count: 3 },
    { query: "delta query", count: 3 },
    { query: "echo query", count: 2 },
    { query: "foxtrot query", count: 2 },
    { query: "golf query", count: 2 },
    { query: "hotel query", count: 2 },
    { query: "india query", count: 2 },
    { query: "juliet query", count: 2 },
  ]);

  assert.deepEqual(await harness.repository.getAnalytics(isolationWorkspace.id), {
    articles: [
      {
        articleId: "article_analytics_isolation",
        title: "Isolation article",
        status: "published",
        views: 5,
        feedbackCount: 1,
        helpfulCount: 1,
      },
    ],
    searchMisses: [{ query: "isolated query", count: 5 }],
  });

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
    async createWorkspace(workspace) {
      await pool.query(
        "insert into workspaces (id, slug, name) values ($1, $2, $3)",
        [workspace.id, workspace.slug, workspace.name],
      );
    },
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
    async createWorkspace(workspace) {
      client
        .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
        .run(workspace.id, workspace.slug, workspace.name);
    },
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
