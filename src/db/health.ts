// ABOUTME: Resolves health probes to the database selected for the current deployment.
// ABOUTME: Gives orchestration one portable readiness contract across targets.
export async function checkDatabase() {
  const driver = process.env.OPAS_DATABASE_DRIVER ?? "postgres";

  if (driver === "d1") {
    const { checkD1 } = await import("@/db/sqlite/health");
    return checkD1();
  }

  if (driver === "postgres") {
    const { checkPostgres } = await import("@/db/postgres/health");
    return checkPostgres();
  }

  throw new Error(`Unsupported OPAS_DATABASE_DRIVER: ${driver}`);
}
