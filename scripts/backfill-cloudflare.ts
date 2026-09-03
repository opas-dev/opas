// ABOUTME: Runs the fence-held team-authoring backfill against local or remote D1.
// ABOUTME: Audits completed baselines through one validated secret-isolated binding.
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createD1TeamAuthoringBackfillStore } from "../src/db/sqlite/d1-team-authoring-backfill";
import { runTeamAuthoringBackfill } from "../src/db/team-authoring-backfill";
import { readCloudflareTarget } from "./bootstrap-cloudflare";
import {
  openCloudflareDataTarget,
  parseCloudflareDataCommand,
} from "./cloudflare-data";

export async function runCloudflareBackfill(
  target: ReturnType<typeof readCloudflareTarget>,
  remote: boolean,
) {
  const data = await openCloudflareDataTarget(target, remote);
  try {
    return await runTeamAuthoringBackfill(
      createD1TeamAuthoringBackfillStore(data.database),
    );
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
  const result = await runCloudflareBackfill(target, command.remote);
  console.info("Reconciled the OPAS team-authoring backfill.", result);
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
