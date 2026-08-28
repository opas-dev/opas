// ABOUTME: Builds the maintained Vercel compatibility artifact with local environment secrets.
// ABOUTME: Pins the Neon adapter and requested stable origin before invoking Vercel.
import { spawnSync } from "node:child_process";
import { loadEnvFile } from "node:process";

import { resolveSiteOrigin } from "../src/site";

const requestedOrigin = process.argv[2];

if (!requestedOrigin) {
  throw new Error("Usage: pnpm vercel:build https://your-stable-origin");
}

const siteOrigin = resolveSiteOrigin(requestedOrigin);

loadEnvFile(".env");

const buildEnvironment: Record<string, string | undefined> = process.env;
buildEnvironment.OPAS_DATABASE_DRIVER = "neon";
buildEnvironment.OPAS_SITE_URL = siteOrigin;

const result = spawnSync("vercel", ["build", "--prod", "--yes"], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
