// ABOUTME: Creates a request-scoped Drizzle client from the Cloudflare D1 binding.
// ABOUTME: Avoids sharing database state across workerd requests and isolates.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "@/db/schema/sqlite";

export function getD1Database() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}
