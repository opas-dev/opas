// ABOUTME: Runs one explicit Postgres database maintenance operation for a deployment.
// ABOUTME: Keeps migrations, authoring backfill, seed data, and evidence independently invokable.
import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { initializeAllMissingArticleEvidence } from "../src/content/article-evidence-initialization";
import { demoIds } from "../src/db/demo";
import {
  closePostgres,
  getPostgresDatabase,
  getPostgresPool,
} from "../src/db/postgres/client";
import { createPostgresRepository } from "../src/db/postgres/repository";
import { reconcilePostgresDemoSeed } from "../src/db/postgres/seed";
import { createPostgresTeamAuthoringBackfillStore } from "../src/db/postgres/team-authoring-backfill";
import { runTeamAuthoringBackfill } from "../src/db/team-authoring-backfill";

export async function runPostgresDatabaseCommand(command: string | undefined) {
  if (
    !(["backfill", "migrate", "seed", "initialize-evidence"] as const).includes(
      command as never,
    )
  ) {
    throw new Error(
      "Usage: prepare-postgres.ts <backfill|migrate|seed|initialize-evidence>",
    );
  }
  try {
    const database = getPostgresDatabase();
    if (command === "migrate") {
      await migrate(database, {
        migrationsFolder: resolve(process.cwd(), "drizzle/postgres"),
      });
      console.info("Applied OPAS Postgres migrations.");
    } else if (command === "backfill") {
      const result = await runTeamAuthoringBackfill(
        createPostgresTeamAuthoringBackfillStore(getPostgresPool()),
      );
      console.info("Reconciled the OPAS team-authoring backfill.", result);
    } else if (command === "seed") {
      const result = await reconcilePostgresDemoSeed(database, {
        configuredSiteUrl: process.env.OPAS_SITE_URL,
      });
      console.info("Reconciled the OPAS Postgres demo seed.", result);
    } else {
      const evidence = await initializeAllMissingArticleEvidence({
        ...(process.env.OPAS_SITE_URL === undefined
          ? {}
          : { configuredSiteUrl: process.env.OPAS_SITE_URL }),
        repository: createPostgresRepository(database),
        workspaceId: demoIds.workspace,
      });
      console.info("Initialized missing OPAS article evidence.", { evidence });
    }
  } finally {
    await closePostgres();
  }
}

runPostgresDatabaseCommand(process.argv[2]).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
