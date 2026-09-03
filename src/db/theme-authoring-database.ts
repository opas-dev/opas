// ABOUTME: Resolves the dedicated theme authoring repository for the active database.
// ABOUTME: Keeps workspace appearance writes behind their exact authorization boundary.
import "server-only";

import { resolveDatabaseDriver } from "@/db/driver";
import type { ThemeAuthoringRepository } from "@/db/theme-authoring";

export async function getThemeAuthoringRepository(): Promise<ThemeAuthoringRepository> {
  const driver = resolveDatabaseDriver();

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteThemeAuthoringRepository }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/theme-authoring-repository"),
      ]);
    return createSqliteThemeAuthoringRepository(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresThemeAuthoringRepository }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/theme-authoring-repository"),
      ]);
    return createPostgresThemeAuthoringRepository(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresThemeAuthoringRepository }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/theme-authoring-repository"),
      ]);
    return createPostgresThemeAuthoringRepository(getPostgresDatabase());
  }

  throw new Error("Unsupported database driver");
}
