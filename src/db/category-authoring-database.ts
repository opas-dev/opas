// ABOUTME: Resolves the dedicated category authoring repository for the active database.
// ABOUTME: Keeps category mutations separate from public and article persistence APIs.
import "server-only";

import type { CategoryAuthoringRepository } from "@/db/category-authoring";
import { resolveDatabaseDriver } from "@/db/driver";

export async function getCategoryAuthoringRepository(): Promise<CategoryAuthoringRepository> {
  const driver = resolveDatabaseDriver();

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteCategoryAuthoringRepository }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/category-authoring-repository"),
      ]);
    return createSqliteCategoryAuthoringRepository(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresCategoryAuthoringRepository }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/category-authoring-repository"),
      ]);
    return createPostgresCategoryAuthoringRepository(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [
      { getPostgresDatabase },
      { createPostgresCategoryAuthoringRepository },
    ] = await Promise.all([
      import("@/db/postgres/client"),
      import("@/db/postgres/category-authoring-repository"),
    ]);
    return createPostgresCategoryAuthoringRepository(getPostgresDatabase());
  }

  throw new Error("Unsupported database driver");
}
