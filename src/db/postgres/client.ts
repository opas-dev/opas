// ABOUTME: Creates the pooled Drizzle client used by Docker Postgres deployments.
// ABOUTME: Reuses the pool during local hot reloads and exposes an explicit shutdown hook for scripts.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema/postgres";

const processState = globalThis as typeof globalThis & {
  opasPostgresPool?: Pool;
};

function createPool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the Postgres deployment");
  }

  return new Pool({ connectionString });
}

export const postgresPool = processState.opasPostgresPool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  processState.opasPostgresPool = postgresPool;
}

export const postgresDb = drizzle(postgresPool, { schema });
