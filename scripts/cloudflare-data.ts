// ABOUTME: Opens a secret-isolated native D1 binding for explicit OPAS data commands.
// ABOUTME: Pins local and remote operations to one validated target and minimal config.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getPlatformProxy } from "wrangler";

import {
  cloudflareCommandEnvironment,
  type CloudflareTarget,
} from "./bootstrap-cloudflare";

const appSecretNamePattern =
  /(?:ACCESS_KEY(?:_ID)?|API_KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIAL|DATABASE_URL|EMAIL|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|SESSION|TOKEN|WEBHOOK)/iu;

export type CloudflareDataCommand = Readonly<{
  configPath: string;
  remote: boolean;
}>;

export function parseCloudflareDataCommand(
  args: readonly string[],
): CloudflareDataCommand {
  const location = args[0];
  const configFlag = args[1];
  const configPath = args[2];
  if (
    (location !== "--local" && location !== "--remote") ||
    configFlag !== "--config" ||
    !configPath ||
    args.length !== 3
  ) {
    throw new Error(
      "Usage: <--local|--remote> --config <wrangler.jsonc>",
    );
  }
  return { configPath, remote: location === "--remote" };
}

export function assertCloudflareDataEnvironment(
  accountId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const safeEnvironment = cloudflareCommandEnvironment(accountId, environment);
  const unexpectedEnvironmentNames = Object.entries(environment).flatMap(
    ([name, value]) =>
      value !== undefined &&
      safeEnvironment[name] !== value &&
      (name.startsWith("OPAS_") || appSecretNamePattern.test(name))
        ? [name]
        : [],
  );
  if (unexpectedEnvironmentNames.length > 0) {
    throw new Error(
      `Cloudflare data commands must run through the secret-isolated command runner; remove ambient variables: ${unexpectedEnvironmentNames.sort().join(", ")}.`,
    );
  }
}

export function cloudflareDataConfig(target: CloudflareTarget) {
  const database = (target.config.d1_databases as readonly Record<
    string,
    unknown
  >[])[0];
  if (!database) {
    throw new Error("The validated Cloudflare target has no D1 binding.");
  }
  return {
    account_id: target.accountId,
    compatibility_date: target.config.compatibility_date,
    compatibility_flags: target.config.compatibility_flags,
    d1_databases: [database],
    name: target.workerName,
  };
}

function prepareDataBinding(target: CloudflareTarget) {
  const directory = mkdtempSync(join(tmpdir(), "opas-d1-data-"));
  const configPath = join(directory, "wrangler.json");
  chmodSync(directory, 0o700);
  writeFileSync(
    configPath,
    `${JSON.stringify(cloudflareDataConfig(target))}\n`,
    { mode: 0o600 },
  );
  return {
    configPath,
    dispose: () => rmSync(directory, { force: true, recursive: true }),
  };
}

export async function openCloudflareDataTarget(
  target: CloudflareTarget,
  remote: boolean,
) {
  assertCloudflareDataEnvironment(target.accountId);
  const binding = prepareDataBinding(target);
  try {
    const platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath: binding.configPath,
      envFiles: [],
      persist: remote
        ? false
        : { path: resolve(dirname(target.configPath), ".wrangler/state/v3") },
      remoteBindings: remote,
    });
    return Object.freeze({
      async close() {
        try {
          await platform.dispose();
        } finally {
          binding.dispose();
        }
      },
      database: platform.env.DB,
    });
  } catch (error) {
    binding.dispose();
    throw error;
  }
}
