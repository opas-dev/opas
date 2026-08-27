// ABOUTME: Confirms that the Postgres deployment can execute a database round trip.
// ABOUTME: Keeps target-specific health logic out of the public API route.
import { getPostgresPool } from "@/db/postgres/client";

export async function checkPostgres() {
  await getPostgresPool().query("select 1");
}
