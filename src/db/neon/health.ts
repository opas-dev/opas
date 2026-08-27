// ABOUTME: Confirms that the Neon deployment can execute a database round trip.
// ABOUTME: Keeps target-specific health logic out of the public API route.
import { sql } from "drizzle-orm";

import { getNeonDatabase } from "@/db/neon/client";

export async function checkNeon() {
  await getNeonDatabase().execute(sql`select 1`);
}
