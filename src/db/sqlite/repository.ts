// ABOUTME: Implements the OPAS repository for injected SQLite-compatible D1 databases.
// ABOUTME: Normalizes D1 records to the same domain contract used by Postgres deployments.
import { and, asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Repository } from "@/db/repository";
import {
  articleFeedback,
  articles,
  articleViews,
  categories,
  searchMisses,
  themes,
} from "@/db/schema/sqlite";
import type * as schema from "@/db/schema/sqlite";

type SqliteDatabase =
  | DrizzleD1Database<typeof schema>
  | BetterSQLite3Database<typeof schema>;

export function createSqliteRepository(database: SqliteDatabase): Repository {
  // Both drivers expose the same execute methods, but Drizzle drops them from its union type.
  const executableDatabase = database as DrizzleD1Database<typeof schema>;

  return {
    async checkHealth() {
      await executableDatabase.run(sql`select 1`);
    },

    async findPublishedArticle(workspaceId, slug) {
      const [article] = await executableDatabase
        .select({
          id: articles.id,
          workspaceId: articles.workspaceId,
          categoryId: articles.categoryId,
          slug: articles.slug,
          title: articles.title,
          mdx: articles.mdx,
          isFaq: articles.isFaq,
          authorName: articles.authorName,
          publishedAt: articles.publishedAt,
          createdAt: articles.createdAt,
          updatedAt: articles.updatedAt,
        })
        .from(articles)
        .where(
          and(
            eq(articles.workspaceId, workspaceId),
            eq(articles.slug, slug),
            eq(articles.status, "published"),
          ),
        )
        .limit(1)
        .execute();

      return article ?? null;
    },

    async listCategories(workspaceId) {
      return executableDatabase
        .select({
          id: categories.id,
          workspaceId: categories.workspaceId,
          slug: categories.slug,
          name: categories.name,
          description: categories.description,
          position: categories.position,
        })
        .from(categories)
        .where(eq(categories.workspaceId, workspaceId))
        .orderBy(asc(categories.position), asc(categories.id))
        .execute();
    },

    async getTheme(workspaceId) {
      const [theme] = await executableDatabase
        .select({
          id: themes.id,
          workspaceId: themes.workspaceId,
          name: themes.name,
          config: themes.config,
          createdAt: themes.createdAt,
          updatedAt: themes.updatedAt,
        })
        .from(themes)
        .where(eq(themes.workspaceId, workspaceId))
        .limit(1)
        .execute();

      return theme ?? null;
    },

    async createFeedback(feedback) {
      await executableDatabase
        .insert(articleFeedback)
        .values({
          id: feedback.id,
          articleId: feedback.articleId,
          helpful: feedback.helpful,
          comment: feedback.comment ?? null,
        })
        .execute();
    },

    async recordView(view) {
      await executableDatabase.insert(articleViews).values(view).execute();
    },

    async recordSearchMiss(miss) {
      await executableDatabase.insert(searchMisses).values(miss).execute();
    },
  };
}
