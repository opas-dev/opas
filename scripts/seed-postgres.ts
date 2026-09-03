// ABOUTME: Runs the reusable Postgres seed operation from a local or deployment command.
// ABOUTME: Closes the process pool so one-shot invocations terminate cleanly.
import { closePostgres } from "../src/db/postgres/client";
import { reconcilePostgresDemoSeed } from "../src/db/postgres/seed";

async function main() {
  try {
    const result = await reconcilePostgresDemoSeed(undefined, {
      configuredSiteUrl: process.env.OPAS_SITE_URL,
    });
    console.info("Reconciled the OPAS Postgres demo seed.", result);
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
