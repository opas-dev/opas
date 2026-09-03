// ABOUTME: Provides operator-only commands for first-member bootstrap and administrator recovery.
// ABOUTME: Emits recovery bearers only into a newly created mode-0600 artifact, never command output.

import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { neon } from "@neondatabase/serverless";
import { drizzle as createNeonDatabase } from "drizzle-orm/neon-http";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  bootstrapOperatorAdministrator,
  issueOperatorRecovery,
  OperatorIdentityError,
  type OperatorBootstrapInput,
  type OperatorBootstrapResult,
  type OperatorIdentityRepository,
  type OperatorRecoveryArtifact,
  type OperatorRecoveryResult,
  type OperatorWorkspaceCreation,
} from "../src/auth/operator-identity";
import { createPostgresOperatorIdentityRepository } from "../src/db/postgres/operator-identity-repository";
import * as postgresSchema from "../src/db/schema/postgres";
import {
  openCloudflareOperatorIdentityRepository,
  type OpenOperatorIdentityRepository,
} from "./operator-identity-cloudflare";

type OperatorIdentityTarget = "cloudflare" | "neon" | "postgres";

type OperatorIdentityCommandBase = Readonly<{
  configPath?: string;
  location?: "local" | "remote";
  persistTo?: string;
  target: OperatorIdentityTarget;
  workspaceReference: string;
}>;

export type OperatorIdentityCommand =
  | (OperatorIdentityCommandBase &
      Readonly<{
        action: "bootstrap";
        displayName: string;
        workspaceCreation?: OperatorWorkspaceCreation;
      }>)
  | (OperatorIdentityCommandBase &
      Readonly<{
        action: "invite";
        email: string;
        outputFile: string;
        siteOrigin: string;
      }>)
  | (OperatorIdentityCommandBase &
      Readonly<{
        action: "reset";
        member: string;
        outputFile: string;
        siteOrigin: string;
      }>);

export type OperatorIdentityCommandResult =
  | OperatorBootstrapResult
  | (OperatorRecoveryResult & Readonly<{ outputFile: string }>);

type OperatorEnvironment = Readonly<
  Record<string, string | undefined> & {
    ADMIN_EMAIL?: string;
    ADMIN_PASSWORD?: string;
    DATABASE_URL?: string;
    NEON_DATABASE_URL?: string;
  }
>;

type RecoveryArtifactWriter = Readonly<{
  discard(): Promise<void>;
  deliver(artifact: OperatorRecoveryArtifact): Promise<void>;
  path: string;
}>;

const usage =
  "Usage: operator-identity.ts bootstrap --target <postgres|neon|cloudflare> --workspace <id-or-slug> --display-name <name> [--create-workspace-id <id> --create-workspace-slug <slug> --create-workspace-name <name>] [Cloudflare options]\n" +
  "       operator-identity.ts invite --target <postgres|neon|cloudflare> --workspace <id-or-slug> --email <address> --site-url <https-origin> --output-file <path> [Cloudflare options]\n" +
  "       operator-identity.ts reset --target <postgres|neon|cloudflare> --workspace <id-or-slug> --member <id-or-email> --site-url <https-origin> --output-file <path> [Cloudflare options]\n" +
  "Cloudflare options: --config <wrangler.jsonc> (--local [--persist-to <directory>]|--remote)";

function invalidCommand(): never {
  throw new Error(`OPERATOR_IDENTITY_COMMAND_INVALID\n${usage}`);
}

function requireValue(args: readonly string[], index: number) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) invalidCommand();
  return value;
}

export function parseOperatorIdentityCommand(
  args: readonly string[],
): OperatorIdentityCommand {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [action, ...options] = normalizedArgs;
  if (action !== "bootstrap" && action !== "invite" && action !== "reset") {
    invalidCommand();
  }

  const values = new Map<string, string>();
  let location: "local" | "remote" | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--local" || option === "--remote") {
      if (location) invalidCommand();
      location = option === "--local" ? "local" : "remote";
      continue;
    }
    if (
      option !== "--config" &&
      option !== "--create-workspace-id" &&
      option !== "--create-workspace-name" &&
      option !== "--create-workspace-slug" &&
      option !== "--display-name" &&
      option !== "--email" &&
      option !== "--member" &&
      option !== "--output-file" &&
      option !== "--persist-to" &&
      option !== "--site-url" &&
      option !== "--target" &&
      option !== "--workspace"
    ) {
      invalidCommand();
    }
    if (values.has(option)) invalidCommand();
    values.set(option, requireValue(options, index));
    index += 1;
  }

  const target = values.get("--target");
  const workspaceReference = values.get("--workspace");
  if (
    (target !== "cloudflare" && target !== "neon" && target !== "postgres") ||
    !workspaceReference
  ) {
    invalidCommand();
  }
  const configPath = values.get("--config");
  const persistTo = values.get("--persist-to");
  if (target === "cloudflare") {
    if (!location || (location === "remote" && persistTo)) invalidCommand();
  } else if (configPath || location || persistTo) {
    invalidCommand();
  }

  const common = {
    configPath: target === "cloudflare" ? (configPath ?? "wrangler.jsonc") : undefined,
    location,
    persistTo,
    target,
    workspaceReference,
  } as const;
  if (action === "bootstrap") {
    const displayName = values.get("--display-name");
    const creationId = values.get("--create-workspace-id");
    const creationName = values.get("--create-workspace-name");
    const creationSlug = values.get("--create-workspace-slug");
    if (
      !displayName ||
      values.has("--email") ||
      values.has("--member") ||
      values.has("--output-file") ||
      values.has("--site-url") ||
      [creationId, creationName, creationSlug].filter(Boolean).length === 1 ||
      [creationId, creationName, creationSlug].filter(Boolean).length === 2
    ) {
      invalidCommand();
    }
    return {
      action,
      ...common,
      displayName,
      ...(creationId && creationName && creationSlug
        ? {
            workspaceCreation: {
              id: creationId,
              name: creationName,
              slug: creationSlug,
            },
          }
        : {}),
    };
  }

  const outputFile = values.get("--output-file");
  const siteOrigin = values.get("--site-url");
  if (
    !outputFile ||
    outputFile === "-" ||
    !siteOrigin ||
    values.has("--display-name") ||
    values.has("--create-workspace-id") ||
    values.has("--create-workspace-name") ||
    values.has("--create-workspace-slug")
  ) {
    invalidCommand();
  }
  if (action === "invite") {
    const email = values.get("--email");
    if (!email || values.has("--member")) invalidCommand();
    return { action, ...common, email, outputFile, siteOrigin };
  }
  const member = values.get("--member");
  if (!member || values.has("--email")) invalidCommand();
  return { action, ...common, member, outputFile, siteOrigin };
}

export async function openRecoveryArtifact(
  outputFile: string,
): Promise<RecoveryArtifactWriter> {
  const path = resolve(outputFile);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.chmod(0o600);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw new Error("RECOVERY_ARTIFACT_UNAVAILABLE");
  }
  let delivered = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return Object.freeze({
    async discard() {
      if (delivered) return;
      try {
        await close();
      } finally {
        await unlink(path).catch(() => undefined);
      }
    },
    async deliver(artifact: OperatorRecoveryArtifact) {
      if (delivered || closed) throw new Error("RECOVERY_ARTIFACT_UNAVAILABLE");
      await handle.writeFile(`${artifact.url}\n`, { encoding: "utf8" });
      await handle.sync();
      await close();
      delivered = true;
    },
    path,
  });
}

export async function runOperatorIdentityCommand(
  command: OperatorIdentityCommand,
  repository: OperatorIdentityRepository,
  environment: OperatorEnvironment,
  artifact?: RecoveryArtifactWriter,
): Promise<OperatorIdentityCommandResult> {
  if (command.action === "bootstrap") {
    const input: OperatorBootstrapInput = {
      adminEmail: environment.ADMIN_EMAIL ?? "",
      adminPassword: environment.ADMIN_PASSWORD ?? "",
      displayName: command.displayName,
      workspaceReference: command.workspaceReference,
      ...(command.workspaceCreation
        ? { workspaceCreation: command.workspaceCreation }
        : {}),
    };
    return bootstrapOperatorAdministrator(repository, input);
  }
  if (!artifact) throw new Error("RECOVERY_ARTIFACT_REQUIRED");
  const result = await issueOperatorRecovery(
    repository,
    {
      ...(command.action === "invite"
        ? { email: command.email, kind: "invite" as const }
        : { kind: "credential_reset" as const, member: command.member }),
      siteOrigin: command.siteOrigin,
      workspaceReference: command.workspaceReference,
    },
    (value) => artifact.deliver(value),
  );
  return Object.freeze({ ...result, outputFile: artifact.path });
}

async function openRepository(
  command: OperatorIdentityCommand,
  environment: OperatorEnvironment,
): Promise<OpenOperatorIdentityRepository> {
  if (command.target === "cloudflare") {
    return openCloudflareOperatorIdentityRepository({
      configPath: command.configPath ?? "wrangler.jsonc",
      location: command.location ?? "local",
      ...(command.persistTo ? { persistTo: command.persistTo } : {}),
    });
  }
  if (command.target === "neon") {
    const connectionString = environment.NEON_DATABASE_URL;
    if (!connectionString) throw new Error("NEON_DATABASE_URL_REQUIRED");
    const database = createNeonDatabase(neon(connectionString), {
      schema: postgresSchema,
    });
    return Object.freeze({
      async close() {},
      repository: createPostgresOperatorIdentityRepository(database),
    });
  }
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString, max: 1 });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  return Object.freeze({
    close: () => pool.end(),
    repository: createPostgresOperatorIdentityRepository(database),
  });
}

export async function main(
  args: readonly string[],
  environment: OperatorEnvironment = process.env,
) {
  const command = parseOperatorIdentityCommand(args);
  const opened = await openRepository(command, environment);
  let artifact: RecoveryArtifactWriter | undefined;
  try {
    if (command.action !== "bootstrap") {
      artifact = await openRecoveryArtifact(command.outputFile);
    }
    const result = await runOperatorIdentityCommand(
      command,
      opened.repository,
      environment,
      artifact,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await artifact?.discard();
    await opened.close();
  }
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const code =
      error instanceof OperatorIdentityError ||
      (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message))
        ? error.message.split("\n", 1)[0]
        : "OPERATOR_IDENTITY_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
