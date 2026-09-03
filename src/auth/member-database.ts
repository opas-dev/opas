// ABOUTME: Resolves named-member and login-admission repositories for the active database.
// ABOUTME: Creates D1 access per request while reusing configured Postgres or Neon clients.
import "server-only";

import type { LoginAdmissionRepository } from "@/auth/login-admission";
import type { MemberRepository } from "@/auth/member-repository";
import { resolveDatabaseDriver } from "@/db/driver";

export async function getMemberRepository(): Promise<MemberRepository> {
  const driver = resolveDatabaseDriver();

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteMemberRepository }] = await Promise.all([
      import("@/db/sqlite/client"),
      import("@/db/sqlite/member-repository"),
    ]);
    return createSqliteMemberRepository(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresMemberRepository }] = await Promise.all([
      import("@/db/neon/client"),
      import("@/db/postgres/member-repository"),
    ]);
    return createPostgresMemberRepository(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresMemberRepository }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/member-repository"),
      ]);
    return createPostgresMemberRepository(getPostgresDatabase());
  }

  throw new Error("Unsupported database driver");
}

export async function getLoginAdmissionRepository(): Promise<LoginAdmissionRepository> {
  const driver = resolveDatabaseDriver();

  if (driver === "d1") {
    const [{ getD1Database }, { createSqliteLoginAdmissionRepository }] =
      await Promise.all([
        import("@/db/sqlite/client"),
        import("@/db/sqlite/login-admission-repository"),
      ]);
    return createSqliteLoginAdmissionRepository(getD1Database());
  }

  if (driver === "neon") {
    const [{ getNeonDatabase }, { createPostgresLoginAdmissionRepository }] =
      await Promise.all([
        import("@/db/neon/client"),
        import("@/db/postgres/login-admission-repository"),
      ]);
    return createPostgresLoginAdmissionRepository(getNeonDatabase());
  }

  if (driver === "postgres") {
    const [{ getPostgresDatabase }, { createPostgresLoginAdmissionRepository }] =
      await Promise.all([
        import("@/db/postgres/client"),
        import("@/db/postgres/login-admission-repository"),
      ]);
    return createPostgresLoginAdmissionRepository(getPostgresDatabase());
  }

  throw new Error("Unsupported database driver");
}
