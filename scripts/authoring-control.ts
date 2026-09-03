// ABOUTME: Gives operators a compare-and-swap workspace authoring pause command.
// ABOUTME: Keeps the production fence outside every application repository and bundle.
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  cloudflareCommandEnvironment,
  prepareCloudflareTargetSnapshot,
  readCloudflareTarget,
  verifyCloudflareDatabaseTarget,
} from "./bootstrap-cloudflare";
import { runCloudflareProcess } from "./cloudflare-process";

export type AuthoringControl = Readonly<{
  changedAt: string;
  changedByMemberId: string | null;
  generation: number;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  writesPaused: boolean;
}>;

export type AuthoringControlCommand = Readonly<{
  action: "inspect" | "pause" | "resume";
  configPath?: string;
  expectedGeneration?: number;
  location?: "local" | "remote";
  persistTo?: string;
  target: "cloudflare" | "neon" | "postgres";
  workspace: string;
}>;

export type AuthoringControlResult = Readonly<{
  changed: boolean;
  control: AuthoringControl;
}>;

export type AuthoringControlStore = Readonly<{
  backfillState(
    workspaceId: string,
  ): Promise<"complete" | "incomplete" | "not-installed">;
  change(
    workspaceId: string,
    expectedGeneration: number,
    writesPaused: boolean,
    changedAt: Date,
  ): Promise<AuthoringControl | null>;
  close(): Promise<void>;
  find(workspace: string): Promise<readonly AuthoringControl[]>;
}>;

type DatabaseRow = Record<string, unknown>;

const postgresTeamAuthoringGuardTargets = [
  ["article_heads_authoring_control_trigger", "article_heads"],
  ["article_slug_claims_authoring_control_trigger", "article_slug_claims"],
  ["article_revisions_authoring_control_trigger", "article_revisions"],
  ["article_revision_assets_authoring_control_trigger", "article_revision_assets"],
  ["article_review_events_authoring_control_trigger", "article_review_events"],
  ["article_preview_grants_authoring_control_insert_trigger", "article_preview_grants"],
  ["article_preview_grants_authoring_control_delete_trigger", "article_preview_grants"],
  ["article_revisions_immutable_trigger", "article_revisions"],
  ["article_revision_assets_immutable_trigger", "article_revision_assets"],
  ["assets_revision_history_delete_trigger", "assets"],
  ["article_review_events_immutable_trigger", "article_review_events"],
  ["article_preview_grants_revocation_update_trigger", "article_preview_grants"],
  ["article_heads_integrity_trigger", "article_heads"],
  ["articles_materialization_integrity_trigger", "articles"],
  ["articles_history_delete_trigger", "articles"],
  ["article_slug_claims_integrity_trigger", "article_slug_claims"],
  ["categories_current_revision_delete_trigger", "categories"],
] as const;

const sqliteTeamAuthoringGuardNames = [
  "article_heads_authoring_control_insert_trigger",
  "article_heads_authoring_control_update_trigger",
  "article_heads_authoring_control_delete_trigger",
  "article_slug_claims_authoring_control_insert_trigger",
  "article_slug_claims_authoring_control_update_trigger",
  "article_slug_claims_authoring_control_delete_trigger",
  "article_revisions_authoring_control_insert_trigger",
  "article_revisions_immutable_update_trigger",
  "article_revisions_immutable_delete_trigger",
  "article_revision_assets_authoring_control_insert_trigger",
  "article_revision_assets_immutable_update_trigger",
  "article_revision_assets_immutable_delete_trigger",
  "assets_revision_history_delete_trigger",
  "article_review_events_authoring_control_insert_trigger",
  "article_review_events_immutable_update_trigger",
  "article_review_events_immutable_delete_trigger",
  "article_preview_grants_authoring_control_insert_trigger",
  "article_preview_grants_revocation_update_trigger",
  "article_preview_grants_authoring_control_delete_trigger",
  "article_heads_integrity_insert_trigger",
  "article_heads_integrity_update_trigger",
  "articles_materialization_insert_trigger",
  "articles_materialization_update_trigger",
  "articles_history_delete_trigger",
  "article_slug_claims_integrity_update_trigger",
  "article_slug_claims_integrity_delete_trigger",
  "categories_current_revision_delete_trigger",
] as const;

const usage =
  "Usage: authoring-control.ts <inspect|pause|resume> --target <postgres|neon|cloudflare> --workspace <id-or-slug> [--expected-generation <n>] [--config <wrangler.jsonc> (--local [--persist-to <directory>]|--remote)]";

function requireValue(args: readonly string[], index: number, option: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.\n${usage}`);
  }
  return value;
}

export function parseAuthoringControlCommand(
  args: readonly string[],
): AuthoringControlCommand {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [action, ...options] = normalizedArgs;
  if (action !== "inspect" && action !== "pause" && action !== "resume") {
    throw new Error(usage);
  }

  let configPath: string | undefined;
  let expectedGeneration: number | undefined;
  let location: "local" | "remote" | undefined;
  let persistTo: string | undefined;
  let target: AuthoringControlCommand["target"] | undefined;
  let workspace: string | undefined;

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--local" || option === "--remote") {
      const nextLocation = option.slice(2) as "local" | "remote";
      if (location) throw new Error("Choose exactly one of --local or --remote.");
      location = nextLocation;
      continue;
    }

    const value = requireValue(options, index, option);
    index += 1;
    if (option === "--config") configPath = value;
    else if (option === "--expected-generation") {
      if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
        throw new Error("--expected-generation must be a non-negative integer.");
      }
      expectedGeneration = Number(value);
      if (!Number.isSafeInteger(expectedGeneration)) {
        throw new Error("--expected-generation must be a safe integer.");
      }
    } else if (option === "--persist-to") persistTo = value;
    else if (option === "--target") {
      if (value !== "postgres" && value !== "neon" && value !== "cloudflare") {
        throw new Error("--target must be postgres, neon, or cloudflare.");
      }
      target = value;
    } else if (option === "--workspace") workspace = value.trim();
    else throw new Error(`Unknown option: ${option}.\n${usage}`);
  }

  if (!target || !workspace) throw new Error(usage);
  if (action === "inspect" && expectedGeneration !== undefined) {
    throw new Error("inspect does not accept --expected-generation.");
  }
  if (action !== "inspect" && expectedGeneration === undefined) {
    throw new Error(`${action} requires --expected-generation from a fresh inspect.`);
  }
  if (target === "cloudflare") {
    if (!location) {
      throw new Error("Cloudflare commands require exactly one of --local or --remote.");
    }
    if (location === "remote" && persistTo) {
      throw new Error("--persist-to is available only with --local.");
    }
  } else if (configPath || location || persistTo) {
    throw new Error("--config, --local, --remote, and --persist-to are Cloudflare-only.");
  }

  return {
    action,
    configPath: target === "cloudflare" ? (configPath ?? "wrangler.jsonc") : undefined,
    expectedGeneration,
    location,
    persistTo,
    target,
    workspace,
  };
}

function parseChangedAt(value: unknown) {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("The authoring control has an invalid change time.");
  }
  return date.toISOString();
}

function parseBoolean(value: unknown) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error("The authoring control has an invalid pause state.");
}

function parseControl(row: DatabaseRow): AuthoringControl {
  const generation = Number(row.generation);
  const workspaceId = row.workspace_id;
  const workspaceSlug = row.workspace_slug;
  const workspaceName = row.workspace_name;
  if (
    typeof workspaceId !== "string" ||
    typeof workspaceSlug !== "string" ||
    typeof workspaceName !== "string" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  ) {
    throw new Error("The authoring control row is malformed.");
  }
  if (row.changed_by_member_id !== null && typeof row.changed_by_member_id !== "string") {
    throw new Error("The authoring control actor is malformed.");
  }
  return {
    changedAt: parseChangedAt(row.changed_at),
    changedByMemberId: row.changed_by_member_id,
    generation,
    workspaceId,
    workspaceName,
    workspaceSlug,
    writesPaused: parseBoolean(row.writes_paused),
  };
}

export async function runAuthoringControlCommand(
  command: AuthoringControlCommand,
  store: AuthoringControlStore,
  clock: () => Date = () => new Date(),
): Promise<AuthoringControlResult> {
  const matches = await store.find(command.workspace);
  if (matches.length === 0) {
    throw new Error(`No workspace matches ${JSON.stringify(command.workspace)}.`);
  }
  if (matches.length !== 1) {
    throw new Error(`Workspace reference ${JSON.stringify(command.workspace)} is ambiguous.`);
  }
  const control = matches[0];
  if (command.action === "inspect") return { changed: false, control };
  if (control.generation !== command.expectedGeneration) {
    throw new Error(
      `Expected fence generation ${command.expectedGeneration}, found ${control.generation}; inspect and retry.`,
    );
  }

  if (
    command.action === "resume" &&
    (await store.backfillState(control.workspaceId)) === "incomplete"
  ) {
    throw new Error(
      "AUTHORING_BACKFILL_INCOMPLETE: the workspace cannot resume until the team-authoring backfill is audited.",
    );
  }

  const writesPaused = command.action === "pause";
  if (control.writesPaused === writesPaused) return { changed: false, control };
  const changed = await store.change(
    control.workspaceId,
    control.generation,
    writesPaused,
    clock(),
  );
  if (!changed) {
    throw new Error("The fence changed concurrently; inspect and retry.");
  }
  return { changed: true, control: changed };
}

const selectControlSql = `
select
  controls.workspace_id,
  controls.writes_paused,
  controls.generation,
  controls.changed_by_member_id,
  controls.changed_at,
  workspaces.slug as workspace_slug,
  workspaces.name as workspace_name
from workspace_authoring_controls controls
inner join workspaces on workspaces.id = controls.workspace_id
where workspaces.id = $1 or workspaces.slug = $1
order by case when workspaces.id = $1 then 0 else 1 end
`;

const changeControlSql = `
with changed as (
  update workspace_authoring_controls
  set
    writes_paused = $3,
    generation = generation + 1,
    changed_by_member_id = null,
    changed_at = $4
  where workspace_id = $1 and generation = $2
  returning *
)
select
  changed.workspace_id,
  changed.writes_paused,
  changed.generation,
  changed.changed_by_member_id,
  changed.changed_at,
  workspaces.slug as workspace_slug,
  workspaces.name as workspace_name
from changed
inner join workspaces on workspaces.id = changed.workspace_id
`;

type Query = (text: string, values: readonly unknown[]) => Promise<readonly DatabaseRow[]>;

export async function readPostgresAuthoringBackfillState(
  query: Query,
  workspaceId: string,
) {
  const installed = await query(
    "select to_regclass('public.workspace_authoring_migrations') is not null as installed",
    [],
  );
  if (!parseBoolean(installed[0]?.installed)) return "not-installed" as const;
  const triggerNames = postgresTeamAuthoringGuardTargets.map(([name]) => name);
  const relationNames = postgresTeamAuthoringGuardTargets.map(([, relation]) => relation);
  const completed = await query(
    `select
       exists (
         select 1 from workspace_authoring_migrations
         where workspace_id = $1 and version = 1
       ) and not exists (
         select 1
         from unnest($2::text[], $3::text[]) required(trigger_name, relation_name)
         where not exists (
           select 1
           from pg_trigger trigger
           inner join pg_class relation on relation.oid = trigger.tgrelid
           inner join pg_namespace namespace on namespace.oid = relation.relnamespace
           where trigger.tgname = required.trigger_name
             and relation.relname = required.relation_name
             and namespace.nspname = current_schema()
             and not trigger.tgisinternal
             and trigger.tgenabled in ('O', 'A')
         )
       ) as completed`,
    [workspaceId, triggerNames, relationNames],
  );
  return parseBoolean(completed[0]?.completed) ? "complete" as const : "incomplete" as const;
}

function createSqlControlStore(query: Query, close: () => Promise<void>): AuthoringControlStore {
  return {
    async backfillState(workspaceId) {
      return readPostgresAuthoringBackfillState(query, workspaceId);
    },
    async change(workspaceId, expectedGeneration, writesPaused, changedAt) {
      const rows = await query(changeControlSql, [
        workspaceId,
        expectedGeneration,
        writesPaused,
        changedAt,
      ]);
      return rows[0] ? parseControl(rows[0]) : null;
    },
    close,
    async find(workspace) {
      return (await query(selectControlSql, [workspace])).map(parseControl);
    },
  };
}

function openPostgresControlStore(): AuthoringControlStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for --target postgres.");
  const pool = new Pool({ connectionString, max: 1 });
  return createSqlControlStore(
    async (text, values) => (await pool.query(text, [...values])).rows as DatabaseRow[],
    () => pool.end(),
  );
}

function openNeonControlStore(): AuthoringControlStore {
  const connectionString = process.env.NEON_DATABASE_URL;
  if (!connectionString) throw new Error("NEON_DATABASE_URL is required for --target neon.");
  const sql = neon(connectionString);
  return createSqlControlStore(
    async (text, values) => (await sql.query(text, [...values])) as DatabaseRow[],
    async () => undefined,
  );
}

function quoteSqliteText(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function parseD1Rows(output: string): readonly DatabaseRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Wrangler returned invalid JSON for the D1 authoring control query.");
  }
  const commands = Array.isArray(parsed) ? parsed : [parsed];
  const rows: DatabaseRow[] = [];
  for (const command of commands) {
    if (
      typeof command === "object" &&
      command !== null &&
      "results" in command &&
      Array.isArray(command.results)
    ) {
      for (const row of command.results) {
        if (typeof row === "object" && row !== null && !Array.isArray(row)) {
          rows.push(row as DatabaseRow);
        }
      }
    }
  }
  return rows;
}

async function openCloudflareControlStore(
  command: AuthoringControlCommand,
): Promise<AuthoringControlStore> {
  const target = readCloudflareTarget(command.configPath ?? "wrangler.jsonc");
  if (command.location === "remote") await verifyCloudflareDatabaseTarget(target);
  const snapshot = prepareCloudflareTargetSnapshot(target);
  let environment: Record<string, string | undefined>;
  try {
    environment = cloudflareCommandEnvironment(target.accountId);
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
  const workspaces = new Map<
    string,
    Pick<AuthoringControl, "workspaceName" | "workspaceSlug">
  >();

  const query = async (sql: string) => {
    const args = [
      "exec",
      "wrangler",
      "d1",
      "execute",
      snapshot.target.databaseName,
      `--${command.location}`,
      "--command",
      sql,
      "--yes",
      "--json",
      "--config",
      snapshot.target.configPath,
    ];
    if (command.location === "local" && command.persistTo) {
      args.push("--persist-to", resolve(command.persistTo));
    }
    const output = await runCloudflareProcess("pnpm", args, {
      captureOutput: true,
      classifyFailure(errorOutput) {
        const detail = errorOutput.trim();
        return detail ? new Error(detail) : undefined;
      },
      cwd: snapshot.directory,
      environment,
    });
    return parseD1Rows(output);
  };

  return {
    async backfillState(workspaceId) {
      const installed = await query(
        "select count(*) as installed from sqlite_master where type = 'table' and name = 'workspace_authoring_migrations'",
      );
      if (Number(installed[0]?.installed) !== 1) return "not-installed";
      const guardNames = sqliteTeamAuthoringGuardNames
        .map(quoteSqliteText)
        .join(", ");
      const completed = await query(`
select
  exists (
    select 1 from workspace_authoring_migrations
    where workspace_id = ${quoteSqliteText(workspaceId)} and version = 1
  ) and (
    select count(*) from sqlite_master
    where type = 'trigger' and name in (${guardNames})
  ) = ${sqliteTeamAuthoringGuardNames.length} as completed;
`);
      return Number(completed[0]?.completed) === 1 ? "complete" : "incomplete";
    },
    async change(workspaceId, expectedGeneration, writesPaused, changedAt) {
      const workspaceReference = quoteSqliteText(workspaceId);
      const rows = await query(`
update workspace_authoring_controls
set
  writes_paused = ${writesPaused ? 1 : 0},
  generation = generation + 1,
  changed_by_member_id = null,
  changed_at = ${changedAt.getTime()}
where workspace_id = ${workspaceReference} and generation = ${expectedGeneration}
returning workspace_id, writes_paused, generation, changed_by_member_id, changed_at;
`);
      const row = rows[0];
      if (!row) return null;
      const workspaceMetadata = workspaces.get(workspaceId);
      if (!workspaceMetadata) {
        throw new Error("The changed D1 workspace was not inspected first.");
      }
      return parseControl({
        ...row,
        workspace_name: workspaceMetadata.workspaceName,
        workspace_slug: workspaceMetadata.workspaceSlug,
      });
    },
    async close() {
      snapshot.dispose();
    },
    async find(workspace) {
      const reference = quoteSqliteText(workspace);
      const controls = (await query(`
select
  controls.workspace_id,
  controls.writes_paused,
  controls.generation,
  controls.changed_by_member_id,
  controls.changed_at,
  workspaces.slug as workspace_slug,
  workspaces.name as workspace_name
from workspace_authoring_controls controls
inner join workspaces on workspaces.id = controls.workspace_id
where workspaces.id = ${reference} or workspaces.slug = ${reference}
order by case when workspaces.id = ${reference} then 0 else 1 end;
`)).map(parseControl);
      for (const control of controls) {
        workspaces.set(control.workspaceId, {
          workspaceName: control.workspaceName,
          workspaceSlug: control.workspaceSlug,
        });
      }
      return controls;
    },
  };
}

async function openAuthoringControlStore(command: AuthoringControlCommand) {
  if (command.target === "postgres") return openPostgresControlStore();
  if (command.target === "neon") return openNeonControlStore();
  return openCloudflareControlStore(command);
}

export async function main(args: readonly string[]) {
  const command = parseAuthoringControlCommand(args);
  const store = await openAuthoringControlStore(command);
  try {
    const result = await runAuthoringControlCommand(command, store);
    console.info(JSON.stringify({ action: command.action, ...result }, null, 2));
  } finally {
    await store.close();
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
