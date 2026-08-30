// ABOUTME: Selects the durable support-handoff store for the active database deployment.
// ABOUTME: Uses the same Postgres, Neon, SQLite, or D1 client policy as application data.
import type { HandoffStore } from "@/handoff/service";
import { resolveDatabaseDriver } from "@/db/driver";

export async function getConfiguredHandoffStore(): Promise<HandoffStore> {
  const driver = resolveDatabaseDriver();

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteSupportHandoffStore }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/support-handoff-store"),
      ]);
    return createSqliteSupportHandoffStore(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresSupportHandoffStore }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/support-handoff-store"),
      ]);
    return createPostgresSupportHandoffStore(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresSupportHandoffStore }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/support-handoff-store"),
      ]);
    return createPostgresSupportHandoffStore(getPostgresDatabase());
  }

  throw new Error("Unsupported support handoff database driver");
}
