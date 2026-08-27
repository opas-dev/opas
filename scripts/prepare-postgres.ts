// ABOUTME: Prepares a Postgres deployment by applying migrations and deterministic seed data.
// ABOUTME: Runs before the standalone server so first boot never serves an uninitialized database.
import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closePostgres, getPostgresDatabase } from "../src/db/postgres/client";
import { seedPostgres } from "../src/db/postgres/seed";

async function main() {
  try {
    await migrate(getPostgresDatabase(), {
      migrationsFolder: resolve(process.cwd(), "drizzle/postgres"),
    });
    await seedPostgres();
    console.info("Prepared the OPAS Postgres database.");
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
