// ABOUTME: Creates the pooled Drizzle client used by Docker Postgres deployments on demand.
// ABOUTME: Defers environment access until runtime and reuses connections during local hot reloads.
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema/postgres";

const processState = globalThis as typeof globalThis & {
  opasPostgresPool?: Pool;
  opasPostgresDatabase?: NodePgDatabase<typeof schema>;
};

export function getPostgresPool() {
  if (processState.opasPostgresPool) {
    return processState.opasPostgresPool;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the Postgres deployment");
  }

  processState.opasPostgresPool = new Pool({ connectionString });
  return processState.opasPostgresPool;
}

export function getPostgresDatabase() {
  if (processState.opasPostgresDatabase) {
    return processState.opasPostgresDatabase;
  }

  processState.opasPostgresDatabase = drizzle(getPostgresPool(), { schema });
  return processState.opasPostgresDatabase;
}

export async function closePostgres() {
  const pool = processState.opasPostgresPool;

  if (pool) {
    await pool.end();
    delete processState.opasPostgresPool;
    delete processState.opasPostgresDatabase;
  }
}
