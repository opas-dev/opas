// ABOUTME: Prepares a Postgres deployment by applying migrations and deterministic seed data.
// ABOUTME: Initializes missing article evidence before the standalone server accepts traffic.
import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { initializeAllMissingArticleEvidence } from "../src/content/article-evidence-initialization";
import { demoIds } from "../src/db/demo";
import { closePostgres, getPostgresDatabase } from "../src/db/postgres/client";
import { createPostgresRepository } from "../src/db/postgres/repository";
import { seedPostgres } from "../src/db/postgres/seed";

async function main() {
  try {
    const database = getPostgresDatabase();
    await migrate(database, {
      migrationsFolder: resolve(process.cwd(), "drizzle/postgres"),
    });
    await seedPostgres(database);
    const evidence = await initializeAllMissingArticleEvidence({
      ...(process.env.OPAS_SITE_URL === undefined
        ? {}
        : { configuredSiteUrl: process.env.OPAS_SITE_URL }),
      repository: createPostgresRepository(database),
      workspaceId: demoIds.workspace,
    });
    console.info("Prepared the OPAS Postgres database.", { evidence });
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
