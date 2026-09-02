// ABOUTME: Exposes secret-isolated Cloudflare build, preview, and deployment commands.
// ABOUTME: Validates every remote target before an OpenNext, migration, or seed invocation.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  cloudflareSeedFile,
  cloudflareCommandEnvironment,
  prepareCloudflareTargetSnapshot,
  readCloudflareTarget,
  verifyCloudflareDatabaseTarget,
} from "./bootstrap-cloudflare";
import {
  buildAndRunCloudflareCommand,
  buildCloudflareArtifact,
  cloudflareCommandArguments,
} from "./cloudflare-artifact";
import { runCloudflareProcess } from "./cloudflare-process";

async function runWrangler(
  args: string[],
  environment: Record<string, string | undefined>,
) {
  await runCloudflareProcess("pnpm", ["exec", "wrangler", ...args], {
    cwd: process.cwd(),
    environment,
  });
}

async function main(args: string[]) {
  const [command, ...commandArgs] = args;
  if (!["build", "deploy", "preview", "migrate", "seed"].includes(command)) {
    throw new Error(
      "Usage: run-cloudflare.ts <build|deploy|preview|migrate|seed> [arguments]",
    );
  }
  const maintenance = commandArgs[0] === "--maintenance";
  if (maintenance && command !== "build") {
    throw new Error("Maintenance mode is available only for isolated Cloudflare builds.");
  }
  const targetArgs = maintenance ? commandArgs.slice(1) : commandArgs;
  const mode =
    command === "migrate" || command === "seed"
      ? "data"
      : command === "build"
        ? "build"
        : command === "deploy"
          ? "deploy"
          : "preview";
  const parsed = cloudflareCommandArguments(targetArgs, mode);
  const target = readCloudflareTarget(parsed.configPath);
  cloudflareCommandEnvironment(target.accountId);
  const environment = {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
  };

  if (command === "build") {
    await buildCloudflareArtifact(targetArgs, {
      environment,
      expectedTarget: target,
      maintenance,
    });
    return;
  }
  if (command === "deploy" || command === "preview") {
    if (command === "deploy") await verifyCloudflareDatabaseTarget(target);
    await buildAndRunCloudflareCommand(command, targetArgs, {
      environment,
      expectedTarget: target,
    });
    return;
  }
  if (command === "migrate") {
    await verifyCloudflareDatabaseTarget(target);
    const snapshot = prepareCloudflareTargetSnapshot(target);
    try {
      await runWrangler(
        [
          "d1",
          "migrations",
          "apply",
          target.databaseName,
          "--remote",
          "--config",
          snapshot.target.configPath,
        ],
        cloudflareCommandEnvironment(target.accountId),
      );
    } finally {
      snapshot.dispose();
    }
    return;
  }
  if (command === "seed") {
    await verifyCloudflareDatabaseTarget(target);
    const snapshot = prepareCloudflareTargetSnapshot(target);
    try {
      await runWrangler(
        [
          "d1",
          "execute",
          target.databaseName,
          "--remote",
          "--file",
          resolve(snapshot.directory, cloudflareSeedFile(target)),
          "--yes",
          "--config",
          snapshot.target.configPath,
        ],
        cloudflareCommandEnvironment(target.accountId),
      );
    } finally {
      snapshot.dispose();
    }
    return;
  }

}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    if (!process.exitCode) process.exitCode = 1;
  });
}
