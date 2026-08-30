// ABOUTME: Selects portable analytics and public-write stores for the active deployment.
// ABOUTME: Reuses the configured Postgres, Neon, SQLite, or D1 database clients.
import type { PublicWriteAdmissionStore } from "@/outcomes/admission";
import type { ConversationAnalyticsStore } from "@/outcomes/store";
import { resolveDatabaseDriver } from "@/db/driver";

export async function getConfiguredConversationAnalyticsStore(): Promise<ConversationAnalyticsStore> {
  const driver = resolveDatabaseDriver();
  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteConversationAnalyticsStore }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/conversation-analytics-store"),
      ]);
    return createSqliteConversationAnalyticsStore(getD1Database());
  }
  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresConversationAnalyticsStore }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/conversation-analytics-store"),
      ]);
    return createPostgresConversationAnalyticsStore(getNeonDatabase());
  }
  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresConversationAnalyticsStore }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/conversation-analytics-store"),
      ]);
    return createPostgresConversationAnalyticsStore(getPostgresDatabase());
  }
  throw new Error("Unsupported conversation analytics database driver");
}

export async function getConfiguredPublicWriteAdmissionStore(): Promise<PublicWriteAdmissionStore> {
  const driver = resolveDatabaseDriver();
  if (driver === "d1") {
    const [{ getD1Database }, { createSqlitePublicWriteAdmissionStore }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/public-write-admission-store"),
      ]);
    return createSqlitePublicWriteAdmissionStore(getD1Database());
  }
  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresPublicWriteAdmissionStore }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/public-write-admission-store"),
      ]);
    return createPostgresPublicWriteAdmissionStore(getNeonDatabase());
  }
  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresPublicWriteAdmissionStore }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/public-write-admission-store"),
      ]);
    return createPostgresPublicWriteAdmissionStore(getPostgresDatabase());
  }
  throw new Error("Unsupported public-write database driver");
}
