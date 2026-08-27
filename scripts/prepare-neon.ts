// ABOUTME: Prepares a Neon deployment by applying Postgres migrations and missing demo records.
// ABOUTME: Uses a direct transactional connection without printing the database connection string.
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { seedPostgres } from "../src/db/postgres/seed";
import * as schema from "../src/db/schema/postgres";

function requireConnectionString() {
  const connectionString = process.env.NEON_DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error("NEON_DATABASE_URL is required to prepare the Neon database");
  }

  return connectionString;
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
    connectionString = requireConnectionString();
    const pool = new Pool({ connectionString });

    try {
      const database = drizzle(pool, { schema });

      await migrate(database, {
        migrationsFolder: resolve(process.cwd(), "drizzle/postgres"),
      });
      await seedPostgres(database);
    } finally {
      await pool.end();
    }
    console.info("Prepared the OPAS Neon database.");
  } catch (error: unknown) {
    console.error(`Neon preparation failed: ${safeErrorMessage(error, connectionString)}`);
    process.exitCode = 1;
  }
}

void main();
