// ABOUTME: Creates and deploys one guarded OPAS Worker and matching D1 database.
// ABOUTME: Rejects configs that could mutate protected or unrelated Cloudflare resources.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const protectedWorkerName = "opas-landing";
const maintainedAccountId = "f8801c7e8853a113a25f8b52fd9ceec1";
const maintainedCustomDomain = "demo.opas.dev";
const maintainedWorkerName = "opas-mvp";
const opasResourcePattern = /^opas-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const cloudflareAccountPattern = /^[a-f0-9]{32}$/;

type JsonObject = Record<string, unknown>;

type D1Database = {
  name: string;
  uuid: string;
};

export type CloudflareTarget = {
  accountId: string;
  config: JsonObject;
  configPath: string;
  databaseId: string | undefined;
  databaseName: string;
  siteOrigin: string;
  sourcePrefix: string;
  workerName: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

function requireOpasResource(value: unknown, field: string) {
  const name = requireString(value, field);

  if (!opasResourcePattern.test(name) || name === protectedWorkerName) {
    throw new Error(
      `${field} must be an opas-* resource and cannot be ${protectedWorkerName}.`,
    );
  }

  return name;
}

function validateRouting(config: JsonObject, accountId: string, workerName: string) {
  if ("route" in config) {
    throw new Error("Singular Worker routes are not permitted.");
  }

  if (!("routes" in config)) {
    if (config.workers_dev === false) {
      throw new Error("workers.dev must remain enabled.");
    }

    return undefined;
  }

  const routes = config.routes;
  const route = Array.isArray(routes) && routes.length === 1 ? routes[0] : undefined;
  const routeKeys = isObject(route) ? Object.keys(route).sort() : [];
  const isMaintainedRoute =
    accountId === maintainedAccountId &&
    workerName === maintainedWorkerName &&
    config.workers_dev === true &&
    isObject(route) &&
    route.pattern === maintainedCustomDomain &&
    route.custom_domain === true &&
    routeKeys.length === 2 &&
    routeKeys[0] === "custom_domain" &&
    routeKeys[1] === "pattern";

  if (!isMaintainedRoute) {
    throw new Error(
      `Custom routing is limited to ${maintainedCustomDomain} on the maintained ${maintainedWorkerName} Worker, with workers.dev enabled.`,
    );
  }

  return maintainedCustomDomain;
}

function validateSiteOrigin(
  value: unknown,
  workerName: string,
  customDomain: string | undefined,
) {
  const configuredOrigin = requireString(value, "vars.OPAS_SITE_URL");
  let siteUrl: URL;

  try {
    siteUrl = new URL(configuredOrigin);
  } catch {
    throw new Error("vars.OPAS_SITE_URL must be a valid HTTPS origin.");
  }

  const hasExpectedHostname = customDomain
    ? siteUrl.hostname === customDomain
    : siteUrl.hostname.startsWith(`${workerName}.`) &&
      siteUrl.hostname.endsWith(".workers.dev");

  if (
    siteUrl.protocol !== "https:" ||
    siteUrl.username !== "" ||
    siteUrl.password !== "" ||
    siteUrl.pathname !== "/" ||
    siteUrl.search !== "" ||
    siteUrl.hash !== "" ||
    siteUrl.origin !== configuredOrigin ||
    !hasExpectedHostname
  ) {
    throw new Error("vars.OPAS_SITE_URL must be an exact HTTPS origin.");
  }

  return siteUrl.origin;
}

export function validateCloudflareConfig(
  config: unknown,
  configPath = "wrangler.jsonc",
): CloudflareTarget {
  if (!isObject(config)) {
    throw new Error("Wrangler config must contain a JSON object.");
  }

  const workerName = requireOpasResource(config.name, "name");
  const accountId = requireString(config.account_id, "account_id");

  if (!cloudflareAccountPattern.test(accountId)) {
    throw new Error("account_id must be an explicit Cloudflare account ID.");
  }

  const customDomain = validateRouting(config, accountId, workerName);

  if (!isObject(config.vars) || config.vars.OPAS_DATABASE_DRIVER !== "d1") {
    throw new Error("vars.OPAS_DATABASE_DRIVER must be d1.");
  }

  const siteOrigin = validateSiteOrigin(
    config.vars.OPAS_SITE_URL,
    workerName,
    customDomain,
  );
  const databases = config.d1_databases;

  if (!Array.isArray(databases) || databases.length !== 1 || !isObject(databases[0])) {
    throw new Error("d1_databases must contain exactly one OPAS database binding.");
  }

  const database = databases[0];
  const databaseName = requireOpasResource(database.database_name, "database_name");

  if (
    database.binding !== "DB" ||
    databaseName !== workerName ||
    database.migrations_dir !== "drizzle/sqlite"
  ) {
    throw new Error("The DB binding, D1 database, and Worker must form one exact OPAS target.");
  }

  const services = config.services;
  const hasSelfReference =
    Array.isArray(services) &&
    services.some(
      (service) =>
        isObject(service) &&
        service.binding === "WORKER_SELF_REFERENCE" &&
        service.service === workerName,
    );

  if (!hasSelfReference) {
    throw new Error("WORKER_SELF_REFERENCE must point to the same OPAS Worker.");
  }

  return {
    accountId,
    config,
    configPath,
    databaseId:
      typeof database.database_id === "string" ? database.database_id : undefined,
    databaseName,
    siteOrigin,
    sourcePrefix: "",
    workerName,
  };
}

export function readCloudflareTarget(configPath: string): CloudflareTarget {
  const workspaceRoot = process.cwd();
  const absoluteConfigPath = resolve(workspaceRoot, configPath);
  const workspaceRelativePath = relative(workspaceRoot, absoluteConfigPath);

  if (
    workspaceRelativePath === "" ||
    workspaceRelativePath.startsWith("..") ||
    isAbsolute(workspaceRelativePath)
  ) {
    throw new Error("Cloudflare config must be a file inside the current workspace.");
  }

  const source = readFileSync(absoluteConfigPath, "utf8");
  const objectStart = source.indexOf("{");

  if (objectStart === -1) {
    throw new Error("Wrangler config must contain a JSON object.");
  }

  let config: unknown;

  try {
    config = JSON.parse(source.slice(objectStart));
  } catch {
    throw new Error("Wrangler config must be JSON with comments only before the object.");
  }

  return {
    ...validateCloudflareConfig(config, absoluteConfigPath),
    sourcePrefix: source.slice(0, objectStart),
  };
}

function validateAdminSecrets() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  const sessionSecret = process.env.ADMIN_SESSION_SECRET ?? "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("ADMIN_EMAIL must contain a valid email address.");
  }

  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must contain at least 8 characters.");
  }

  if (new TextEncoder().encode(sessionSecret).byteLength < 32) {
    throw new Error("ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }

  return { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: sessionSecret };
}

function run(command: string, args: string[]) {
  console.info(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

function capture(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }

  return result.stdout;
}

function listD1Databases(configPath: string) {
  const output = capture("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "list",
    "--json",
    "--config",
    configPath,
  ]);
  let result: unknown;

  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("Wrangler returned an invalid D1 database list.");
  }

  if (!Array.isArray(result)) {
    throw new Error("Wrangler returned an invalid D1 database list.");
  }

  return result.flatMap((entry): D1Database[] => {
    if (
      !isObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.uuid !== "string"
    ) {
      return [];
    }

    return [{ name: entry.name, uuid: entry.uuid }];
  });
}

function saveDatabaseId(target: CloudflareTarget, databaseId: string) {
  const databases = target.config.d1_databases;

  if (!Array.isArray(databases) || !isObject(databases[0])) {
    throw new Error("Cannot update the validated D1 binding.");
  }

  databases[0].database_id = databaseId;
  const prefix = target.sourcePrefix.trimEnd();
  const contents = `${prefix.length > 0 ? `${prefix}\n` : ""}${JSON.stringify(
    target.config,
    null,
    2,
  )}\n`;
  writeFileSync(target.configPath, contents, "utf8");
}

function resolveD1Database(target: CloudflareTarget) {
  let exactMatches = listD1Databases(target.configPath).filter(
    (database) => database.name === target.databaseName,
  );

  if (exactMatches.length === 0) {
    run("pnpm", [
      "exec",
      "wrangler",
      "d1",
      "create",
      target.databaseName,
      "--location",
      "eeur",
      "--config",
      target.configPath,
    ]);
    exactMatches = listD1Databases(target.configPath).filter(
      (database) => database.name === target.databaseName,
    );
  }

  if (exactMatches.length !== 1) {
    throw new Error("Expected exactly one D1 database matching the configured OPAS target.");
  }

  const database = exactMatches[0];

  if (target.databaseId !== database.uuid) {
    saveDatabaseId(target, database.uuid);
    console.info(`Pinned ${target.databaseName} to its exact D1 database ID.`);
  }
}

function parseConfigPath(args: string[]) {
  if (args.length === 0) {
    return "wrangler.jsonc";
  }

  if (args.length === 2 && args[0] === "--config" && args[1].length > 0) {
    return args[1];
  }

  throw new Error("Usage: bootstrap-cloudflare.ts [--config <wrangler.jsonc>]");
}

function main() {
  const target = readCloudflareTarget(parseConfigPath(process.argv.slice(2)));
  const adminSecrets = validateAdminSecrets();
  const seedPath = resolve(process.cwd(), "scripts/seed-d1.sql");
  const migrationsPath = resolve(dirname(target.configPath), "drizzle/sqlite");

  if (!existsSync(seedPath) || !existsSync(migrationsPath)) {
    throw new Error("Cloudflare migrations and seed SQL must exist before bootstrap.");
  }

  capture("pnpm", ["exec", "wrangler", "whoami", "--config", target.configPath]);
  console.info(`Authenticated for guarded target ${target.workerName}.`);

  run("pnpm", [
    "exec",
    "opennextjs-cloudflare",
    "build",
    "--config",
    target.configPath,
  ]);
  resolveD1Database(target);
  run("pnpm", [
    "exec",
    "opennextjs-cloudflare",
    "deploy",
    "--config",
    target.configPath,
    "--dry-run",
  ]);

  run("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    target.databaseName,
    "--remote",
    "--config",
    target.configPath,
  ]);
  run("pnpm", [
    "exec",
    "wrangler",
    "d1",
    "execute",
    target.databaseName,
    "--remote",
    "--file",
    seedPath,
    "--yes",
    "--config",
    target.configPath,
  ]);

  const secretDirectory = mkdtempSync(join(tmpdir(), "opas-cloudflare-"));
  const secretPath = join(secretDirectory, "secrets.json");

  try {
    writeFileSync(secretPath, JSON.stringify(adminSecrets), { mode: 0o600 });
    run("pnpm", [
      "exec",
      "opennextjs-cloudflare",
      "deploy",
      "--config",
      target.configPath,
      "--secrets-file",
      secretPath,
    ]);
  } finally {
    if (existsSync(secretPath)) {
      unlinkSync(secretPath);
    }
    rmdirSync(secretDirectory);
  }

  run("bash", [resolve(process.cwd(), "scripts/smoke.sh"), target.siteOrigin]);
  console.info(`\nCloudflare bootstrap complete: ${target.siteOrigin}`);
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
