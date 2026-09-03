// ABOUTME: Parses Phase 16 acceptance targets and proves they are disposable before any database access.
// ABOUTME: Couples one run ID to the loopback, Vercel, or route-free Cloudflare resource identity.

import { createHash } from "node:crypto";

import type { CloudflareTarget } from "./bootstrap-cloudflare";

export type TeamAuthoringAcceptanceCommand = Readonly<{
  confirmation: string;
  configPath?: string;
  origin: string;
  runId: string;
  target: "cloudflare" | "docker" | "vercel";
}>;

export type TeamAuthoringAcceptanceEnvironment = Readonly<
  Record<string, string | undefined> & Partial<
    Record<
      | "DATABASE_URL"
      | "NEON_DATABASE_URL"
      | "OPAS_ACCEPTANCE_PREVIEW_SIGNING_SECRET",
      string | undefined
    >
  >
>;

const usage =
  "Usage: team-authoring-acceptance.ts --target <docker|cloudflare|vercel> --origin <origin> --run-id <id> --confirm-disposable <same-id> [--config <route-free-wrangler-config>]";
const maintainedHostnameHashes = new Set([
  "186b27ade90e713ac6d28c90c25e5dceed6f29c0d55f6a34a9a3a8db16727e3c",
  "fc02b9de65cc2e4ce95c284f946a0f88a731101c209d18217f89f3e8fea6d984",
  "41ef35b8582fcdfb5c352bbc466099012953b828c58f7bd094204c80d921b284",
  "793b303c46caf07644dc2010c40c9dc9f33d8d485851e3e9ac12991b9f154131",
]);
const cloudflareWorkersDomain = ["timo-bejan", "workers", "dev"].join(".");
const vercelTeamDomain = ["timo-bejans-projects", "vercel", "app"].join(".");
const permittedNeonConnectionParameters = new Set(["channel_binding", "sslmode"]);
const permittedNeonSslModes = new Set(["require", "verify-full"]);

function invalid(code: string): never {
  throw new Error(code);
}

function optionValue(args: readonly string[], index: number) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) invalid("ACCEPTANCE_ARGUMENTS_INVALID");
  return value;
}

export function parseTeamAuthoringAcceptanceCommand(
  args: readonly string[],
): TeamAuthoringAcceptanceCommand {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      option !== "--config" &&
      option !== "--confirm-disposable" &&
      option !== "--origin" &&
      option !== "--run-id" &&
      option !== "--target"
    ) {
      invalid("ACCEPTANCE_ARGUMENTS_INVALID");
    }
    if (values.has(option)) invalid("ACCEPTANCE_ARGUMENTS_INVALID");
    values.set(option, optionValue(args, index));
    index += 1;
  }

  const target = values.get("--target");
  const origin = values.get("--origin");
  const runId = values.get("--run-id");
  const confirmation = values.get("--confirm-disposable");
  const configPath = values.get("--config");
  if (
    (target !== "cloudflare" && target !== "docker" && target !== "vercel") ||
    !origin ||
    !runId ||
    !confirmation ||
    (target === "cloudflare" ? !configPath : configPath !== undefined)
  ) {
    throw new Error(`ACCEPTANCE_ARGUMENTS_INVALID\n${usage}`);
  }
  if (
    runId.length < 8 ||
    runId.length > 40 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(runId) ||
    confirmation !== runId
  ) {
    invalid("ACCEPTANCE_DISPOSABLE_CONFIRMATION_INVALID");
  }
  return { confirmation, configPath, origin, runId, target };
}

function canonicalOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("ACCEPTANCE_ORIGIN_INVALID");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !["http:", "https:"].includes(parsed.protocol)
  ) {
    invalid("ACCEPTANCE_ORIGIN_INVALID");
  }
  const hostnameHash = createHash("sha256").update(parsed.hostname).digest("hex");
  if (maintainedHostnameHashes.has(hostnameHash)) {
    invalid("ACCEPTANCE_MAINTAINED_TARGET_FORBIDDEN");
  }
  return parsed;
}

function expectedResourceName(runId: string) {
  return `opas-acceptance-${runId}`;
}

function expectedDatabaseName(runId: string) {
  return `opas_acceptance_${runId.replaceAll("-", "_")}`;
}

function databaseName(connectionString: string) {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    invalid("ACCEPTANCE_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.hash ||
    !/^\/[A-Za-z0-9_]+$/u.test(parsed.pathname)
  ) {
    invalid("ACCEPTANCE_DATABASE_URL_INVALID");
  }
  return { name: decodeURIComponent(parsed.pathname.slice(1)), url: parsed };
}

function rejectConnectionParameters(url: URL) {
  if (url.search !== "") invalid("ACCEPTANCE_DATABASE_PARAMETERS_FORBIDDEN");
}

function validateNeonConnectionParameters(url: URL) {
  const seen = new Set<string>();
  for (const [parameter] of url.searchParams) {
    if (
      !permittedNeonConnectionParameters.has(parameter) ||
      seen.has(parameter)
    ) {
      invalid("ACCEPTANCE_NEON_PARAMETERS_INVALID");
    }
    seen.add(parameter);
  }
  if (!permittedNeonSslModes.has(url.searchParams.get("sslmode") ?? "")) {
    invalid("ACCEPTANCE_NEON_PARAMETERS_INVALID");
  }
  const channelBinding = url.searchParams.get("channel_binding");
  if (channelBinding !== null && channelBinding !== "require") {
    invalid("ACCEPTANCE_NEON_PARAMETERS_INVALID");
  }
}

export function validateDatabaseAcceptanceTarget(
  command: TeamAuthoringAcceptanceCommand,
  environment: TeamAuthoringAcceptanceEnvironment,
) {
  const origin = canonicalOrigin(command.origin);
  const expectedName = expectedDatabaseName(command.runId);
  if (command.target === "docker") {
    if (
      origin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
    ) {
      invalid("ACCEPTANCE_DOCKER_ORIGIN_NOT_LOOPBACK");
    }
    const connectionString = environment.DATABASE_URL;
    if (!connectionString) invalid("ACCEPTANCE_DATABASE_URL_MISSING");
    const database = databaseName(connectionString);
    rejectConnectionParameters(database.url);
    if (
      database.name !== expectedName ||
      !["127.0.0.1", "localhost", "[::1]"].includes(database.url.hostname)
    ) {
      invalid("ACCEPTANCE_DATABASE_NOT_DISPOSABLE");
    }
    return Object.freeze({
      connectionString,
      databaseName: database.name,
      kind: "docker-postgres" as const,
      origin: origin.origin,
    });
  }

  if (command.target !== "vercel") invalid("ACCEPTANCE_TARGET_INVALID");
  const expectedHostname = `${expectedResourceName(command.runId)}-${vercelTeamDomain}`;
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== expectedHostname
  ) {
    invalid("ACCEPTANCE_VERCEL_ORIGIN_NOT_DISPOSABLE");
  }
  const connectionString = environment.NEON_DATABASE_URL;
  if (!connectionString) invalid("ACCEPTANCE_NEON_URL_MISSING");
  const database = databaseName(connectionString);
  validateNeonConnectionParameters(database.url);
  if (
    database.name !== expectedName ||
    !database.url.hostname.endsWith(".neon.tech")
  ) {
    invalid("ACCEPTANCE_NEON_DATABASE_NOT_DISPOSABLE");
  }
  return Object.freeze({
    connectionString,
    databaseName: database.name,
    kind: "vercel-neon" as const,
    origin: origin.origin,
  });
}

export function validateCloudflareAcceptanceTarget(
  command: TeamAuthoringAcceptanceCommand,
  target: CloudflareTarget,
) {
  if (command.target !== "cloudflare") invalid("ACCEPTANCE_TARGET_INVALID");
  const origin = canonicalOrigin(command.origin);
  const expectedName = expectedResourceName(command.runId);
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== `${expectedName}.${cloudflareWorkersDomain}` ||
    target.workerName !== expectedName ||
    target.databaseName !== expectedName ||
    !target.databaseId ||
    target.siteOrigin !== origin.origin ||
    target.config.workers_dev !== true ||
    target.config.preview_urls !== false ||
    "route" in target.config ||
    "routes" in target.config
  ) {
    invalid("ACCEPTANCE_CLOUDFLARE_TARGET_NOT_DISPOSABLE");
  }
  return Object.freeze({
    databaseId: target.databaseId,
    databaseName: target.databaseName,
    kind: "cloudflare-d1" as const,
    origin: origin.origin,
    workerName: target.workerName,
  });
}

export function acceptancePreviewSecret(environment: TeamAuthoringAcceptanceEnvironment) {
  const secret = environment.OPAS_ACCEPTANCE_PREVIEW_SIGNING_SECRET ?? "";
  if (new TextEncoder().encode(secret).byteLength < 32) {
    invalid("ACCEPTANCE_PREVIEW_SECRET_MISSING");
  }
  return secret;
}
