// ABOUTME: Writes the deterministic OPAS demo content to a D1-compatible database.
// ABOUTME: Accepts an injected Drizzle client so production and integration checks share seed logic.
import { demoContent, demoSeededAt } from "@/db/demo";
import { getD1Database } from "@/db/sqlite/client";
import { articles, categories, themes, workspaces } from "@/db/schema/sqlite";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";

type SqliteDatabase =
  | DrizzleD1Database<typeof import("@/db/schema/sqlite")>
  | BetterSQLite3Database<typeof import("@/db/schema/sqlite")>;

export async function seedD1(database: SqliteDatabase = getD1Database()) {
  const seededAt = new Date(demoSeededAt);

  await database
    .insert(workspaces)
    .values({
      ...demoContent.workspace,
      createdAt: seededAt,
      updatedAt: seededAt,
    })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: {
        slug: demoContent.workspace.slug,
        name: demoContent.workspace.name,
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    })
    .execute();

  for (const category of demoContent.categories) {
    await database
      .insert(categories)
      .values({
        ...category,
        createdAt: seededAt,
        updatedAt: seededAt,
      })
      .onConflictDoUpdate({
        target: categories.id,
        set: {
          workspaceId: category.workspaceId,
          slug: category.slug,
          name: category.name,
          description: category.description,
          position: category.position,
          createdAt: seededAt,
          updatedAt: seededAt,
        },
      })
      .execute();
  }

  for (const article of demoContent.articles) {
    const publishedAt = article.publishedAt ? new Date(article.publishedAt) : null;

    await database
      .insert(articles)
      .values({
        ...article,
        publishedAt,
        createdAt: seededAt,
        updatedAt: seededAt,
      })
      .onConflictDoUpdate({
        target: articles.id,
        set: {
          workspaceId: article.workspaceId,
          categoryId: article.categoryId,
          slug: article.slug,
          title: article.title,
          mdx: article.mdx,
          status: article.status,
          isFaq: article.isFaq,
          authorName: article.authorName,
          publishedAt,
          createdAt: seededAt,
          updatedAt: seededAt,
        },
      })
      .execute();
  }

  await database
    .insert(themes)
    .values({
      ...demoContent.theme,
      createdAt: seededAt,
      updatedAt: seededAt,
    })
    .onConflictDoUpdate({
      target: themes.id,
      set: {
        workspaceId: demoContent.theme.workspaceId,
        name: demoContent.theme.name,
        config: demoContent.theme.config,
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    })
    .execute();
}
