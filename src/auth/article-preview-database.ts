// ABOUTME: Resolves the signed-preview repository for the active database target.
// ABOUTME: Creates request-local D1 access while reusing configured Postgres or Neon clients.
import "server-only";

import type { ArticlePreviewRepository } from "@/auth/article-preview";
import { resolveDatabaseDriver } from "@/db/driver";

export async function getArticlePreviewRepository(): Promise<ArticlePreviewRepository> {
  const driver = resolveDatabaseDriver();

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteArticlePreviewRepository }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/article-preview-repository"),
      ]);
    return createSqliteArticlePreviewRepository(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresArticlePreviewRepository }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/article-preview-repository"),
      ]);
    return createPostgresArticlePreviewRepository(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresArticlePreviewRepository }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/article-preview-repository"),
      ]);
    return createPostgresArticlePreviewRepository(getPostgresDatabase());
  }

  throw new Error("Unsupported database driver");
}
