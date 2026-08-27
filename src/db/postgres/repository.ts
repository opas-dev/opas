// ABOUTME: Implements the OPAS repository for Postgres-compatible Drizzle databases.
// ABOUTME: Shares identical queries between Docker Postgres and Neon deployments.
import { and, asc, eq, lt, notExists, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Repository } from "@/db/repository";
import { searchMissRetentionStart } from "@/db/search-misses";
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

const articleFields = {
  id: articles.id,
  workspaceId: articles.workspaceId,
  categoryId: articles.categoryId,
  slug: articles.slug,
  title: articles.title,
  mdx: articles.mdx,
  status: articles.status,
  isFaq: articles.isFaq,
  authorName: articles.authorName,
  publishedAt: articles.publishedAt,
  createdAt: articles.createdAt,
  updatedAt: articles.updatedAt,
};

const publishedArticleFields = {
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
};

export function createPostgresRepository(database: PostgresDatabase): Repository {
  return {
    async checkHealth() {
      await database.execute(sql`select 1`);
    },

    async findPublishedArticle(workspaceId, slug) {
      const [article] = await database
        .select(publishedArticleFields)
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

    async listPublishedArticles(workspaceId) {
      return database
        .select(publishedArticleFields)
        .from(articles)
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.status, "published")))
        .orderBy(asc(articles.title), asc(articles.id));
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

    async createCategory(category) {
      await database.insert(categories).values(category);
    },

    async updateCategory(category) {
      await database
        .update(categories)
        .set({
          slug: category.slug,
          name: category.name,
          description: category.description,
          position: category.position,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(categories.workspaceId, category.workspaceId),
            eq(categories.id, category.id),
          ),
        );
    },

    async deleteCategory(workspaceId, id) {
      const deleted = await database
        .delete(categories)
        .where(
          and(
            eq(categories.workspaceId, workspaceId),
            eq(categories.id, id),
            notExists(
              database
                .select({ id: articles.id })
                .from(articles)
                .where(eq(articles.categoryId, id)),
            ),
          ),
        )
        .returning();
      return deleted.length === 1;
    },

    async listArticles(workspaceId) {
      return database
        .select(articleFields)
        .from(articles)
        .where(eq(articles.workspaceId, workspaceId))
        .orderBy(asc(articles.title), asc(articles.id));
    },

    async getArticle(workspaceId, id) {
      const [article] = await database
        .select(articleFields)
        .from(articles)
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.id, id)))
        .limit(1);

      return article ?? null;
    },

    async createArticle(article) {
      await database.insert(articles).values(article);
    },

    async updateArticle(article) {
      await database
        .update(articles)
        .set({
          categoryId: article.categoryId,
          slug: article.slug,
          title: article.title,
          mdx: article.mdx,
          status: article.status,
          isFaq: article.isFaq,
          authorName: article.authorName,
          publishedAt: article.publishedAt,
          updatedAt: new Date(),
        })
        .where(
          and(eq(articles.workspaceId, article.workspaceId), eq(articles.id, article.id)),
        );
    },

    async deleteArticle(workspaceId, id) {
      await database
        .delete(articles)
        .where(and(eq(articles.workspaceId, workspaceId), eq(articles.id, id)));
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
      await database
        .delete(searchMisses)
        .where(
          and(
            eq(searchMisses.workspaceId, miss.workspaceId),
            lt(searchMisses.createdAt, searchMissRetentionStart(miss.createdAt)),
          ),
        );
      await database.insert(searchMisses).values(miss).onConflictDoNothing({
        target: searchMisses.id,
      });
    },
  };
}
