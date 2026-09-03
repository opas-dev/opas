// ABOUTME: Runs one explicit Neon database maintenance operation through a direct connection.
// ABOUTME: Keeps migrations, authoring backfill, seed data, and evidence independently invokable.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolConfig } from "pg";

import { initializeAllMissingArticleEvidence } from "../src/content/article-evidence-initialization";
import { demoIds } from "../src/db/demo";
import { createPostgresRepository } from "../src/db/postgres/repository";
import { reconcilePostgresDemoSeed } from "../src/db/postgres/seed";
import { createPostgresTeamAuthoringBackfillStore } from "../src/db/postgres/team-authoring-backfill";
import * as schema from "../src/db/schema/postgres";
import { runTeamAuthoringBackfill } from "../src/db/team-authoring-backfill";
import { requireNeonDirectConnectionString } from "./neon-connections";

export { requireNeonDirectConnectionString };

export function neonPoolConfiguration(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  return {
    database: decodeURI(url.pathname.slice(1)),
    enableChannelBinding: true,
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port: Number(url.port || "5432"),
    ssl: { rejectUnauthorized: true },
    user: decodeURIComponent(url.username),
  };
}

function safeErrorMessage(error: unknown, connectionString: string) {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  const secrets = new Set([connectionString]);

  try {
    const password = new URL(connectionString).password;

    if (password) {
      secrets.add(password);
      secrets.add(decodeURIComponent(password));
    }
  } catch {
    // Connection validation belongs to the Neon driver; redacting the original value is sufficient here.
  }

  let message = error.message;

  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }

  return `${error.name}: ${message}`;
}

export async function runNeonDatabaseCommand(command: string | undefined) {
  if (
    !(["backfill", "migrate", "seed", "initialize-evidence"] as const).includes(
      command as never,
    )
  ) {
    throw new Error(
      "Usage: prepare-neon.ts <backfill|migrate|seed|initialize-evidence>",
    );
  }
  let connectionString = "";

  try {
    connectionString = requireNeonDirectConnectionString();
    const pool = new Pool(neonPoolConfiguration(connectionString));

    try {
      const database = drizzle(pool, { schema });

      if (command === "migrate") {
        await migrate(database, {
          migrationsFolder: resolve(process.cwd(), "drizzle/postgres"),
        });
        console.info("Applied OPAS Neon migrations.");
      } else if (command === "backfill") {
        const result = await runTeamAuthoringBackfill(
          createPostgresTeamAuthoringBackfillStore(pool),
        );
        console.info("Reconciled the OPAS team-authoring backfill.", result);
      } else if (command === "seed") {
        const result = await reconcilePostgresDemoSeed(database, {
          configuredSiteUrl: process.env.OPAS_SITE_URL,
        });
        console.info("Reconciled the OPAS Neon demo seed.", result);
      } else {
        const evidence = await initializeAllMissingArticleEvidence({
          ...(process.env.OPAS_SITE_URL === undefined
            ? {}
            : { configuredSiteUrl: process.env.OPAS_SITE_URL }),
          repository: createPostgresRepository(database),
          workspaceId: demoIds.workspace,
        });
        console.info("Initialized missing OPAS Neon article evidence.", { evidence });
      }
    } finally {
      await pool.end();
    }
  } catch (error: unknown) {
    console.error(`Neon preparation failed: ${safeErrorMessage(error, connectionString)}`);
    process.exitCode = 1;
  }
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) void runNeonDatabaseCommand(process.argv[2]);
