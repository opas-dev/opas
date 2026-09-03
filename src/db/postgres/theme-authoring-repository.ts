// ABOUTME: Applies exact runtime-theme writes atomically on Postgres and Neon.
// ABOUTME: Rechecks the authoring fence, administrator session, and theme version.
import { sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
} from "@/db/authoring-controls";
import type * as schema from "@/db/schema/postgres";
import {
  themeAuthoringTime,
  type AuthoringTheme,
  type ThemeAuthoringRepository,
  type ThemeAuthoringRepositoryOptions,
  type ThemeMutationResult,
  type UpdateThemeRequest,
  validExpectedThemeVersion,
} from "@/db/theme-authoring";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

type DatabaseRow = Readonly<Record<string, unknown>>;

function isNeonDatabase(
  database: PostgresDatabase,
): database is NeonHttpDatabase<typeof schema> {
  return "batch" in database;
}

function resultRows<T extends DatabaseRow>(value: unknown): T[] {
  return value !== null &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray(value.rows)
    ? (value.rows as T[])
    : [];
}

async function transaction(database: PostgresDatabase, statements: readonly SQL[]) {
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    return database.batch(queries as [Query, ...Query[]]);
  }
  return database.transaction(async (connection) => {
    const results: unknown[] = [];
    for (const statement of statements) {
      results.push(await connection.execute(statement));
    }
    return results;
  });
}

function date(value: unknown, field: string) {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Theme repository returned an invalid ${field}.`);
  }
  return parsed;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Theme repository returned an invalid ${field}.`);
  }
  return value;
}

function theme(row: DatabaseRow): AuthoringTheme {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Theme repository returned an invalid version.");
  }
  return Object.freeze({
    config: row.config,
    createdAt: date(row.createdAt, "creation time"),
    id: text(row.id, "ID"),
    name: text(row.name, "name"),
    updatedAt: date(row.updatedAt, "update time"),
    version,
    workspaceId: text(row.workspaceId, "workspace ID"),
  });
}

function themeSelection(workspaceId: string) {
  return sql`
    select id, workspace_id as "workspaceId", name, config, version,
           created_at as "createdAt", updated_at as "updatedAt"
    from themes where workspace_id = ${workspaceId} limit 1
  `;
}

async function readTheme(database: PostgresDatabase, workspaceId: string) {
  const row = resultRows<DatabaseRow>(
    await database.execute(themeSelection(workspaceId)),
  )[0];
  return row ? theme(row) : null;
}

function actorAssertion(request: UpdateThemeRequest, checkedAt: Date) {
  return sql`
    select 1 / count(*)::integer
    from (
      select member.id
      from workspace_members member
      inner join admin_sessions session
        on session.workspace_id = member.workspace_id
       and session.member_id = member.id
      where member.workspace_id = ${request.theme.workspaceId}
        and member.id = ${request.actor.memberId}
        and member.status = 'active'
        and member.role = 'administrator'
        and session.id = ${request.actor.sessionId}
        and session.revoked_at is null
        and session.expires_at > ${checkedAt}
        and ${request.actor.workspaceId} = ${request.theme.workspaceId}
      for share of member, session
    ) authorized_actor
  `;
}

function themeVersionAssertion(request: UpdateThemeRequest) {
  return sql`
    select 1 / count(*)::integer
    from (
      select theme.id from themes theme
      where theme.workspace_id = ${request.theme.workspaceId}
        and theme.id = ${request.theme.id}
        and theme.version = ${request.expectedThemeVersion}
      for update of theme
    ) current_theme
  `;
}

async function actorIsAuthorized(
  database: PostgresDatabase,
  request: UpdateThemeRequest,
  checkedAt: Date,
) {
  if (request.actor.workspaceId !== request.theme.workspaceId) return false;
  return resultRows<DatabaseRow>(await database.execute(sql`
    select member.id
    from workspace_members member
    inner join admin_sessions session
      on session.workspace_id = member.workspace_id
     and session.member_id = member.id
    where member.workspace_id = ${request.theme.workspaceId}
      and member.id = ${request.actor.memberId}
      and member.status = 'active'
      and member.role = 'administrator'
      and session.id = ${request.actor.sessionId}
      and session.revoked_at is null
      and session.expires_at > ${checkedAt}
    limit 1
  `)).length === 1;
}

async function authoringIsOpen(database: PostgresDatabase, workspaceId: string) {
  const row = resultRows<DatabaseRow>(await database.execute(sql`
    select writes_paused as "writesPaused"
    from workspace_authoring_controls
    where workspace_id = ${workspaceId}
    limit 1
  `))[0];
  if (!row || row.writesPaused === true) throw new AuthoringPausedError();
}

async function classifyFailure(
  database: PostgresDatabase,
  request: UpdateThemeRequest,
  checkedAt: Date,
  error: unknown,
): Promise<ThemeMutationResult> {
  const normalized = normalizeAuthoringError(error);
  if (normalized instanceof AuthoringPausedError) throw normalized;
  await authoringIsOpen(database, request.theme.workspaceId);
  if (!(await actorIsAuthorized(database, request, checkedAt))) {
    return { status: "rejected", code: "ACTOR_FORBIDDEN" };
  }
  const current = await readTheme(database, request.theme.workspaceId);
  if (!current || current.id !== request.theme.id) {
    return { status: "rejected", code: "THEME_NOT_FOUND" };
  }
  if (current.version !== request.expectedThemeVersion) {
    return {
      status: "conflict",
      code: "STALE_THEME",
      currentVersion: current.version,
    };
  }
  throw error;
}

export function createPostgresThemeAuthoringRepository(
  database: PostgresDatabase,
  options?: ThemeAuthoringRepositoryOptions,
): ThemeAuthoringRepository {
  return {
    async getTheme(workspaceId) {
      return readTheme(database, workspaceId);
    },

    async updateTheme(request) {
      if (!validExpectedThemeVersion(request.expectedThemeVersion)) {
        return { status: "rejected", code: "INVALID_THEME_VERSION" };
      }
      const changedAt = themeAuthoringTime(options);
      const config = JSON.stringify(request.theme.config);
      try {
        const results = await transaction(database, [
          authoringAssertion(request.theme.workspaceId, "postgres"),
          actorAssertion(request, changedAt),
          themeVersionAssertion(request),
          sql`
            update themes
            set name = ${request.theme.name},
                config = ${config}::jsonb,
                version = version + 1,
                updated_at = ${changedAt}
            where workspace_id = ${request.theme.workspaceId}
              and id = ${request.theme.id}
              and version = ${request.expectedThemeVersion}
              and (
                name is distinct from ${request.theme.name}
                or config is distinct from ${config}::jsonb
              )
          `,
          themeSelection(request.theme.workspaceId),
        ]);
        const storedRow = resultRows<DatabaseRow>(results[results.length - 1])[0];
        if (!storedRow) throw new Error("THEME_MUTATION_RESULT_INVALID");
        const stored = theme(storedRow);
        if (
          stored.id !== request.theme.id ||
          (stored.version !== request.expectedThemeVersion &&
            stored.version !== request.expectedThemeVersion + 1)
        ) {
          throw new Error("THEME_MUTATION_RESULT_INVALID");
        }
        return {
          status:
            stored.version === request.expectedThemeVersion
              ? "unchanged"
              : "updated",
          theme: stored,
        };
      } catch (error) {
        return classifyFailure(database, request, changedAt, error);
      }
    },
  };
}
