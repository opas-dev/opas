// ABOUTME: Resolves the repository implementation selected for the current deployment.
// ABOUTME: Creates D1 access per request while reusing each target's database client policy.
import type { Repository } from "@/db/repository";

export async function getRepository(): Promise<Repository> {
  const driver = process.env.OPAS_DATABASE_DRIVER ?? "postgres";

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteRepository }] = await Promise.all([
      import("@/db/sqlite/client"),
      import("@/db/sqlite/repository"),
    ]);
    return createSqliteRepository(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresRepository }] = await Promise.all([
      import("@/db/neon/client"),
      import("@/db/postgres/repository"),
    ]);
    return createPostgresRepository(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresRepository }] = await Promise.all([
      import("@/db/postgres/client"),
      import("@/db/postgres/repository"),
    ]);
    return createPostgresRepository(getPostgresDatabase());
  }

  throw new Error(`Unsupported OPAS_DATABASE_DRIVER: ${driver}`);
}
