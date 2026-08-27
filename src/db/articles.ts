// ABOUTME: Resolves article reads to the database selected for the current deployment.
// ABOUTME: Keeps public routes independent from Postgres, Neon, and D1 driver details.
export async function findPublishedArticle(workspaceId: string, slug: string) {
  const driver = process.env.OPAS_DATABASE_DRIVER ?? "postgres";

  if (driver === "d1") {
    const repository = await import("@/db/sqlite/articles");
    return repository.findPublishedArticle(workspaceId, slug);
  }

  if (driver === "postgres") {
    const repository = await import("@/db/postgres/articles");
    return repository.findPublishedArticle(workspaceId, slug);
  }

  throw new Error(`Unsupported OPAS_DATABASE_DRIVER: ${driver}`);
}
