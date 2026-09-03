// ABOUTME: Runs the revision-aware demo seed through a native local or remote D1 binding.
// ABOUTME: Uses the same typed repository batch for maintained generic and CROFusion targets.
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/d1";

import * as schema from "../src/db/schema/sqlite";
import { reconcileSqliteDemoSeed } from "../src/db/sqlite/seed";
import {
  cloudflareSeedProfile,
  readCloudflareTarget,
  type CloudflareTarget,
} from "./bootstrap-cloudflare";
import {
  openCloudflareDataTarget,
  parseCloudflareDataCommand,
} from "./cloudflare-data";

export async function runCloudflareSeed(
  target: CloudflareTarget,
  remote: boolean,
) {
  const data = await openCloudflareDataTarget(target, remote);
  try {
    return await reconcileSqliteDemoSeed(drizzle(data.database, { schema }), {
      configuredSiteUrl: target.siteOrigin,
      profile: cloudflareSeedProfile(target),
    });
  } finally {
    await data.close();
  }
}

async function main(args: readonly string[]) {
  const command = parseCloudflareDataCommand(args);
  const absoluteConfigPath = resolve(command.configPath);
  const target = readCloudflareTarget(
    basename(absoluteConfigPath),
    dirname(absoluteConfigPath),
  );
  const result = await runCloudflareSeed(target, command.remote);
  console.info("Reconciled the OPAS Cloudflare demo seed.", result);
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
