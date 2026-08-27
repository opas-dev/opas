// ABOUTME: Reads OPAS article content from Neon through dialect-safe Drizzle queries.
// ABOUTME: Returns only published articles for the public help center.
import { and, eq } from "drizzle-orm";

import { getNeonDatabase } from "@/db/neon/client";
import { articles } from "@/db/schema/postgres";

export async function findPublishedArticle(workspaceId: string, slug: string) {
  const [article] = await getNeonDatabase()
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
