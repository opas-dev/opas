// ABOUTME: Exposes secret-isolated Cloudflare build, preview, and deployment commands.
// ABOUTME: Validates every remote target before an OpenNext or database invocation.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  cloudflareCommandEnvironment,
  prepareCloudflareTargetSnapshot,
  readCloudflareTarget,
  validateCloudflareSecrets,
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
  if (
    !["backfill", "build", "deploy", "preview", "migrate", "seed"].includes(
      command,
    )
  ) {
    throw new Error(
      "Usage: run-cloudflare.ts <backfill|build|deploy|preview|migrate|seed> [arguments]",
    );
  }
  const maintenance = commandArgs[0] === "--maintenance";
  if (maintenance && command !== "build") {
    throw new Error("Maintenance mode is available only for isolated Cloudflare builds.");
  }
  const localData =
    (command === "backfill" || command === "seed") &&
    commandArgs[0] === "--local";
  const targetArgs = maintenance
    ? commandArgs.slice(1)
    : localData
      ? commandArgs.slice(1)
      : commandArgs;
  const mode =
    command === "backfill" || command === "migrate" || command === "seed"
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
    if (command === "preview") {
      await buildAndRunCloudflareCommand(command, targetArgs, {
        environment,
        expectedTarget: target,
      });
      return;
    }
    const secrets = validateCloudflareSecrets(
      process.env,
      target.config.vars as Record<string, unknown>,
    );
    const directory = mkdtempSync(join(tmpdir(), "opas-cloudflare-secrets-"));
    const path = join(directory, "secrets.json");
    chmodSync(directory, 0o700);
    try {
      writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
      await buildAndRunCloudflareCommand(
        command,
        [...targetArgs, "--secrets-file", path],
        { environment, expectedSecrets: secrets, expectedTarget: target },
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
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
  if (command === "backfill" || command === "seed") {
    if (!localData) {
      await verifyCloudflareDatabaseTarget(target);
    }
    const runDataCommand = async (configPath: string) => {
      await runCloudflareProcess(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(
            process.cwd(),
            command === "seed"
              ? "scripts/seed-cloudflare.ts"
              : "scripts/backfill-cloudflare.ts",
          ),
          localData ? "--local" : "--remote",
          "--config",
          configPath,
        ],
        {
          cwd: process.cwd(),
          environment: cloudflareCommandEnvironment(target.accountId),
        },
      );
    };
    if (localData) {
      await runDataCommand(target.configPath);
      return;
    }
    const snapshot = prepareCloudflareTargetSnapshot(target);
    try {
      await runDataCommand(snapshot.target.configPath);
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
