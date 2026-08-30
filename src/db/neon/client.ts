// ABOUTME: Creates the Drizzle client used by Vercel's Neon deployment on demand.
// ABOUTME: Defers credential access until runtime and reuses the stateless HTTP client.
import { neon } from "@neondatabase/serverless";
import { createHash, timingSafeEqual } from "node:crypto";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";

import * as schema from "@/db/schema/postgres";
import { artifactNeonDatabaseUrlSha256 } from "@/db/deployment-identity";

const processState = globalThis as typeof globalThis & {
  opasNeonDatabase?: NeonHttpDatabase<typeof schema>;
};

export function assertNeonConnectionIdentity(
  connectionString: string,
  expectedHash: string | undefined,
) {
  if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
    throw new Error(
      "The artifact Neon connection identity is required for this deployment",
    );
  }
  const actual = createHash("sha256").update(connectionString).digest();
  const expected = Buffer.from(expectedHash, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(
      "NEON_DATABASE_URL does not match the database selected by this artifact",
    );
  }
}

export function getNeonDatabase() {
  if (processState.opasNeonDatabase) {
    return processState.opasNeonDatabase;
  }

  const connectionString = process.env.NEON_DATABASE_URL;

  if (!connectionString) {
    throw new Error("NEON_DATABASE_URL is required for the Neon deployment");
  }
  assertNeonConnectionIdentity(
    connectionString,
    artifactNeonDatabaseUrlSha256,
  );

  processState.opasNeonDatabase = drizzle(neon(connectionString), { schema });
  return processState.opasNeonDatabase;
}
