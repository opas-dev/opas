// ABOUTME: Expires one preview grant only inside a validated disposable acceptance database.
// ABOUTME: Restores immutable-grant guards in the same transaction that shifts the fixture clock.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  cloudflareCommandEnvironment,
  readCloudflareTarget,
  verifyCloudflareDatabaseTarget,
  type CloudflareTarget,
} from "./bootstrap-cloudflare";
import { openCloudflareDataTarget } from "./cloudflare-data";
import { runCloudflareProcess } from "./cloudflare-process";
import {
  parseTeamAuthoringAcceptanceCommand,
  validateCloudflareAcceptanceTarget,
  validateDatabaseAcceptanceTarget,
  type TeamAuthoringAcceptanceCommand,
  type TeamAuthoringAcceptanceEnvironment,
} from "./team-authoring-acceptance-target";

import { decodeBase64Url } from "@/auth/security-encoding";
import { teamAuthoringStandard } from "@/evaluation/fixtures/team-authoring-standard";
import {
  expireD1PreviewAcceptanceGrant,
  previewAcceptanceExpiryResult,
  previewAcceptanceExpiryTimestamps,
  type PreviewAcceptanceExpiryRequest,
} from "@/evaluation/preview-acceptance-expiry";

export type PreviewAcceptanceExpiryCommand = TeamAuthoringAcceptanceCommand &
  Readonly<{
    grantId: string;
    location?: "local" | "remote";
  }>;

const usage =
  "Usage: expire-preview-acceptance-grant.ts --target <docker|vercel|cloudflare> --origin <origin> --run-id <id> --confirm-disposable <same-id> --grant-id <id> [--config <route-free-wrangler-config> <--local|--remote>]";
const cloudflareChildMarker = "CLOUDFLARE_DATA_COMMAND_CHILD";
function invalid(code = "PREVIEW_EXPIRY_ARGUMENTS_INVALID"): never {
  throw new Error(`${code}\n${usage}`);
}

function optionValue(args: readonly string[], index: number) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) invalid();
  return value;
}

export function parsePreviewAcceptanceExpiryCommand(
  args: readonly string[],
): PreviewAcceptanceExpiryCommand {
  const values = new Map<string, string>();
  let location: "local" | "remote" | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--local" || option === "--remote") {
      if (location) invalid();
      location = option === "--local" ? "local" : "remote";
      continue;
    }
    if (
      option !== "--config" &&
      option !== "--confirm-disposable" &&
      option !== "--grant-id" &&
      option !== "--origin" &&
      option !== "--run-id" &&
      option !== "--target"
    ) {
      invalid();
    }
    if (values.has(option)) invalid();
    values.set(option, optionValue(args, index));
    index += 1;
  }

  const grantId = values.get("--grant-id") ?? "";
  const target = values.get("--target");
  if (decodeBase64Url(grantId)?.byteLength !== 32) {
    invalid("PREVIEW_EXPIRY_GRANT_ID_INVALID");
  }
  if ((target === "cloudflare") !== (location !== undefined)) {
    invalid("PREVIEW_EXPIRY_LOCATION_INVALID");
  }

  const acceptanceArgs = [
    "--target",
    target ?? "",
    "--origin",
    values.get("--origin") ?? "",
    "--run-id",
    values.get("--run-id") ?? "",
    "--confirm-disposable",
    values.get("--confirm-disposable") ?? "",
    ...(values.has("--config")
      ? ["--config", values.get("--config") as string]
      : []),
  ];
  const acceptance = parseTeamAuthoringAcceptanceCommand(acceptanceArgs);
  return Object.freeze({ ...acceptance, grantId, location });
}

export async function expirePostgresPreviewAcceptanceGrant(
  connectionString: string,
  request: PreviewAcceptanceExpiryRequest,
) {
  const timestamps = previewAcceptanceExpiryTimestamps(
    request.expiredAt,
    request.checkedAt,
  );
  const pool = new Pool({ connectionString, max: 1 });
  const connection = await pool.connect();
  try {
    await connection.query("begin");
    try {
      const identity = await connection.query<{ name: string }>(
        "select current_database() as name",
      );
      if (identity.rows[0]?.name !== request.databaseName) {
        throw new Error("PREVIEW_EXPIRY_DATABASE_IDENTITY_CHANGED");
      }
      await connection.query(
        "alter table article_preview_grants disable trigger article_preview_grants_revocation_update_trigger",
      );
      const changed = await connection.query<{ id: string }>(
        `update article_preview_grants
         set created_at = $3, expires_at = $4
         where id = $1
           and workspace_id = $2
           and revoked_at is null
           and expires_at > $5
         returning id`,
        [
          request.grantId,
          request.workspaceId,
          timestamps.createdAt,
          timestamps.expiredAt,
          request.checkedAt,
        ],
      );
      if (changed.rowCount !== 1 || changed.rows[0]?.id !== request.grantId) {
        throw new Error("PREVIEW_EXPIRY_ACTIVE_GRANT_NOT_FOUND");
      }
      await connection.query(
        "alter table article_preview_grants enable trigger article_preview_grants_revocation_update_trigger",
      );
      await connection.query("commit");
    } catch (error) {
      await connection.query("rollback");
      throw error;
    }
  } finally {
    connection.release();
    await pool.end();
  }
  return previewAcceptanceExpiryResult(request.grantId, timestamps.expiredAt);
}

export function validatePreviewAcceptanceExpiryDatabaseTarget(
  command: PreviewAcceptanceExpiryCommand,
  environment: TeamAuthoringAcceptanceEnvironment,
) {
  return validateDatabaseAcceptanceTarget(command, environment);
}

export function validatePreviewAcceptanceExpiryCloudflareTarget(
  command: PreviewAcceptanceExpiryCommand,
  target: CloudflareTarget,
) {
  return validateCloudflareAcceptanceTarget(command, target);
}

export async function runPreviewAcceptanceExpiryCommand(
  args: readonly string[],
  environment: TeamAuthoringAcceptanceEnvironment = process.env,
  clock: () => Date = () => new Date(),
) {
  const command = parsePreviewAcceptanceExpiryCommand(args);
  const checkedAt = clock();
  const expiredAt = new Date(checkedAt.getTime() - 1_000);
  if (command.target !== "cloudflare") {
    const target = validatePreviewAcceptanceExpiryDatabaseTarget(
      command,
      environment,
    );
    return expirePostgresPreviewAcceptanceGrant(target.connectionString, {
      checkedAt,
      databaseName: target.databaseName,
      expiredAt,
      grantId: command.grantId,
      workspaceId: teamAuthoringStandard.workspaceId,
    });
  }

  const target = readCloudflareTarget(command.configPath ?? "");
  const checked = validatePreviewAcceptanceExpiryCloudflareTarget(command, target);
  if (command.location === "remote") {
    await verifyCloudflareDatabaseTarget(target);
  }
  const opened = await openCloudflareDataTarget(
    target,
    command.location === "remote",
  );
  try {
    return await expireD1PreviewAcceptanceGrant(opened.database, {
      checkedAt,
      databaseName: checked.databaseName,
      expiredAt,
      grantId: command.grantId,
      workspaceId: teamAuthoringStandard.workspaceId,
    });
  } finally {
    await opened.close();
  }
}

function errorCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+(?:\n[\s\S]*)?$/u.test(error.message)
    ? error.message.split("\n", 1)[0]
    : "PREVIEW_EXPIRY_COMMAND_FAILED";
}

export function cloudflarePreviewExpiryChildEnvironment(
  accountId: string,
  environment: TeamAuthoringAcceptanceEnvironment,
): Record<string, string | undefined> {
  return {
    ...cloudflareCommandEnvironment(accountId, environment),
    [cloudflareChildMarker]: "1",
  };
}

export function previewExpiryChildFailure(output: string) {
  for (const line of output.trim().split("\n").reverse()) {
    try {
      const result = JSON.parse(line) as { code?: unknown; outcome?: unknown };
      if (
        result.outcome === "refused" &&
        typeof result.code === "string" &&
        /^[A-Z0-9_]+$/u.test(result.code)
      ) {
        return new Error(result.code);
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function main(
  args: readonly string[],
  environment: TeamAuthoringAcceptanceEnvironment = process.env,
) {
  try {
    const command = parsePreviewAcceptanceExpiryCommand(args);
    if (
      command.target === "cloudflare" &&
      environment[cloudflareChildMarker] !== "1"
    ) {
      const target = readCloudflareTarget(command.configPath ?? "");
      validatePreviewAcceptanceExpiryCloudflareTarget(command, target);
      const output = await runCloudflareProcess(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve(process.cwd(), "scripts/expire-preview-acceptance-grant.ts"),
          ...args,
        ],
        {
          captureOutput: true,
          classifyFailure: previewExpiryChildFailure,
          cwd: process.cwd(),
          environment: cloudflarePreviewExpiryChildEnvironment(
            target.accountId,
            environment,
          ),
        },
      );
      process.stdout.write(output);
      return;
    }
    process.stdout.write(
      `${JSON.stringify(await runPreviewAcceptanceExpiryCommand(args, environment))}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ code: errorCode(error), outcome: "refused" })}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (import.meta.url === invokedModule) {
  void main(process.argv.slice(2));
}
