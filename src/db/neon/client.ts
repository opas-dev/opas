// ABOUTME: Creates the Drizzle client used by Vercel's Neon deployment on demand.
// ABOUTME: Defers credential access until runtime and reuses the stateless HTTP client.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";

import * as schema from "@/db/schema/postgres";

const processState = globalThis as typeof globalThis & {
  opasNeonDatabase?: NeonHttpDatabase<typeof schema>;
};

export function getNeonDatabase() {
  if (processState.opasNeonDatabase) {
    return processState.opasNeonDatabase;
  }

  const connectionString = process.env.NEON_DATABASE_URL;

  if (!connectionString) {
    throw new Error("NEON_DATABASE_URL is required for the Neon deployment");
  }

  processState.opasNeonDatabase = drizzle(neon(connectionString), { schema });
  return processState.opasNeonDatabase;
}
