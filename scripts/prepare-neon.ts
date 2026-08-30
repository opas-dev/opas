// ABOUTME: Prepares a Neon deployment by applying Postgres migrations and missing demo records.
// ABOUTME: Initializes missing evidence through a direct connection without printing its string.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolConfig } from "pg";

import { initializeAllMissingArticleEvidence } from "../src/content/article-evidence-initialization";
import { demoIds } from "../src/db/demo";
import { createPostgresRepository } from "../src/db/postgres/repository";
import { seedPostgres } from "../src/db/postgres/seed";
import * as schema from "../src/db/schema/postgres";
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

async function main() {
  let connectionString = "";

  try {
    connectionString = requireNeonDirectConnectionString();
    const pool = new Pool(neonPoolConfiguration(connectionString));

    try {
      const database = drizzle(pool, { schema });

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
      console.info("Prepared the OPAS Neon database.", { evidence });
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

if (import.meta.url === invokedModule) void main();
