// ABOUTME: Reads OPAS article content from D1 through dialect-safe Drizzle queries.
// ABOUTME: Returns only published articles for the public help center.
import { and, eq } from "drizzle-orm";

import { articles } from "@/db/schema/sqlite";
import { getD1Database } from "@/db/sqlite/client";

export async function findPublishedArticle(workspaceId: string, slug: string) {
  const [article] = await getD1Database()
    .select({
      id: articles.id,
      slug: articles.slug,
      title: articles.title,
      mdx: articles.mdx,
      publishedAt: articles.publishedAt,
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
}
