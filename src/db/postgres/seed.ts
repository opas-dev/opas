// ABOUTME: Writes the deterministic OPAS demo content to a Postgres-compatible database.
// ABOUTME: Restores missing seed records without replacing administrator edits on restart.
import { getPostgresDatabase } from "@/db/postgres/client";
import { demoContent, demoSeededAt } from "@/db/demo";
import { articles, categories, themes, workspaces } from "@/db/schema/postgres";
import { and, eq, inArray } from "drizzle-orm";

export async function seedPostgres(database = getPostgresDatabase()) {
  const seededAt = new Date(demoSeededAt);

  await database
    .insert(workspaces)
    .values({
      ...demoContent.workspace,
      createdAt: seededAt,
      updatedAt: seededAt,
    })
    .onConflictDoNothing();

  const [workspace] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, demoContent.workspace.id))
    .limit(1);
  if (!workspace) {
    return;
  }

  for (const category of demoContent.categories) {
    await database
      .insert(categories)
      .values({
        ...category,
        createdAt: seededAt,
        updatedAt: seededAt,
      })
      .onConflictDoNothing();
  }

  const seededCategories = await database
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.workspaceId, demoContent.workspace.id),
        inArray(categories.id, demoContent.categories.map(({ id }) => id)),
      ),
    );
  const seededCategoryIds = new Set(seededCategories.map(({ id }) => id));

  for (const article of demoContent.articles) {
    if (!seededCategoryIds.has(article.categoryId)) {
      continue;
    }

    const publishedAt = article.publishedAt ? new Date(article.publishedAt) : null;

    await database
      .insert(articles)
      .values({
        ...article,
        publishedAt,
        createdAt: seededAt,
        updatedAt: seededAt,
      })
      .onConflictDoNothing();
  }

  await database
    .insert(themes)
    .values({
      ...demoContent.theme,
      createdAt: seededAt,
      updatedAt: seededAt,
    })
    .onConflictDoNothing();
}
