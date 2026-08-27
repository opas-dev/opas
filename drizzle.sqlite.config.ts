// ABOUTME: Configures Drizzle Kit migrations for OPAS SQLite and D1 deployments.
// ABOUTME: Generates dialect-specific SQL without connecting to a live database.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/sqlite.ts",
  out: "./drizzle/sqlite",
});
