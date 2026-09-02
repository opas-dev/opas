// ABOUTME: Writes the deterministic OPAS demo content to a D1-compatible database.
// ABOUTME: Restores missing seed records without replacing administrator edits on restart.
import { demoContent, demoSeededAt } from "@/db/demo";
import { AuthoringPausedError } from "@/db/authoring-controls";
import { getD1Database } from "@/db/sqlite/client";
import {
  articles,
  categories,
  themes,
  workspaceAuthoringControls,
  workspaces,
} from "@/db/schema/sqlite";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";

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
    .onConflictDoNothing()
    .execute();

  const [authoringControl] = await database
    .select()
    .from(workspaceAuthoringControls)
    .where(eq(workspaceAuthoringControls.workspaceId, demoContent.workspace.id))
    .limit(1)
    .execute();
  if (!authoringControl || authoringControl.writesPaused) {
    throw new AuthoringPausedError();
  }

  const [workspace] = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, demoContent.workspace.id))
    .limit(1)
    .execute();
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
      .onConflictDoNothing()
      .execute();
  }

  const seededCategories = await database
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.workspaceId, demoContent.workspace.id),
        inArray(categories.id, demoContent.categories.map(({ id }) => id)),
      ),
    )
    .execute();
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
      .onConflictDoNothing()
      .execute();
  }

  await database
    .insert(themes)
    .values({
      ...demoContent.theme,
      createdAt: seededAt,
      updatedAt: seededAt,
    })
    .onConflictDoNothing()
    .execute();
}
