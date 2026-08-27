// ABOUTME: Configures Drizzle Kit migrations for OPAS Postgres deployments.
// ABOUTME: Reads the local or container database URL without embedding credentials.
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Postgres migrations");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/postgres.ts",
  out: "./drizzle/postgres",
  dbCredentials: {
    url: databaseUrl,
  },
});
