// ABOUTME: Runs the reusable Postgres seed operation from a local or deployment command.
// ABOUTME: Closes the process pool so one-shot invocations terminate cleanly.
import { closePostgres } from "../src/db/postgres/client";
import { seedPostgres } from "../src/db/postgres/seed";

async function main() {
  try {
    await seedPostgres();
    console.info("Seeded the OPAS Postgres demo content.");
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
