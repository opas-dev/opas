// ABOUTME: Implements the OPAS repository for Postgres-compatible Drizzle databases.
// ABOUTME: Shares identical queries between Docker Postgres and Neon deployments.
import { and, asc, eq, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Repository } from "@/db/repository";
import {
  articleFeedback,
  articles,
  articleViews,
  categories,
  searchMisses,
  themes,
} from "@/db/schema/postgres";
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

export function createPostgresRepository(database: PostgresDatabase): Repository {
  return {
    async checkHealth() {
      await database.execute(sql`select 1`);
    },

    async findPublishedArticle(workspaceId, slug) {
      const [article] = await database
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
        .limit(1);

      return article ?? null;
    },

    async listCategories(workspaceId) {
      return database
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
        .orderBy(asc(categories.position), asc(categories.id));
    },

    async getTheme(workspaceId) {
      const [theme] = await database
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
        .limit(1);

      return theme ?? null;
    },

    async updateTheme(theme) {
      await database
        .update(themes)
        .set({
          name: theme.name,
          config: theme.config,
          updatedAt: new Date(),
        })
        .where(eq(themes.workspaceId, theme.workspaceId));
    },

    async createFeedback(feedback) {
      await database.insert(articleFeedback).values({
        id: feedback.id,
        articleId: feedback.articleId,
        helpful: feedback.helpful,
        comment: feedback.comment ?? null,
      });
    },

    async recordView(view) {
      await database.insert(articleViews).values(view);
    },

    async recordSearchMiss(miss) {
      await database.insert(searchMisses).values(miss);
    },
  };
}
