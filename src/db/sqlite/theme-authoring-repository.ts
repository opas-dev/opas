// ABOUTME: Applies exact runtime-theme writes atomically on SQLite and Cloudflare D1.
// ABOUTME: Batches the authoring fence, administrator session, and theme version check.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import {
  AuthoringPausedError,
  authoringAssertion,
  normalizeAuthoringError,
} from "@/db/authoring-controls";
import type * as schema from "@/db/schema/sqlite";
import {
  themeAuthoringTime,
  type AuthoringTheme,
  type ThemeAuthoringRepository,
  type ThemeAuthoringRepositoryOptions,
  type ThemeMutationResult,
  type UpdateThemeRequest,
  validExpectedThemeVersion,
} from "@/db/theme-authoring";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

type DatabaseRow = Readonly<Record<string, unknown>>;

type TransactionStatement = Readonly<{
  returnsRows?: boolean;
  statement: SQL;
}>;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function d1Statement(database: D1BackedDatabase, statement: SQL) {
  const query = database.run(statement).getQuery();
  return database.$client.prepare(query.sql).bind(...query.params);
}

async function transaction(
  database: SqliteDatabase,
  statements: readonly TransactionStatement[],
) {
  if (isD1Database(database)) {
    return database.$client.batch(
      statements.map(({ statement }) => d1Statement(database, statement)),
    );
  }
  return database.transaction((connection) => {
    return statements.map(({ returnsRows, statement }) =>
      returnsRows ? connection.all(statement) : connection.run(statement),
    );
  });
}

function execute(statement: SQL): TransactionStatement {
  return { statement };
}

function read(statement: SQL): TransactionStatement {
  return { returnsRows: true, statement };
}

function resultRows<T extends DatabaseRow>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  return value !== null &&
    typeof value === "object" &&
    "results" in value &&
    Array.isArray(value.results)
    ? (value.results as T[])
    : [];
}

async function rows(database: SqliteDatabase, statement: SQL) {
  if (isD1Database(database)) {
    return resultRows<DatabaseRow>(await d1Statement(database, statement).all());
  }
  return database.all<DatabaseRow>(statement);
}

function date(value: unknown, field: string) {
  const milliseconds = Number(value);
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(parsed.getTime())) {
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
  let config = row.config;
  if (typeof config === "string") config = JSON.parse(config);
  return Object.freeze({
    config,
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
    select id, workspace_id as workspaceId, name, config, version,
           created_at as createdAt, updated_at as updatedAt
    from themes where workspace_id = ${workspaceId} limit 1
  `;
}

async function readTheme(database: SqliteDatabase, workspaceId: string) {
  const row = (await rows(database, themeSelection(workspaceId)))[0];
  return row ? theme(row) : null;
}

function sqliteAssertion(condition: SQL) {
  return sql`
    select json_extract('[]', case when ${condition} then '$[0]' else '$[' end)
  `;
}

function jsonChanged(stored: SQL, requested: string) {
  return sql`exists (
      select fullkey, type, atom from json_tree(${stored})
      except
      select fullkey, type, atom from json_tree(${requested})
    ) or exists (
      select fullkey, type, atom from json_tree(${requested})
      except
      select fullkey, type, atom from json_tree(${stored})
    )`;
}

function actorCondition(request: UpdateThemeRequest, checkedAt: Date) {
  return sql`exists (
    select 1
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
      and session.expires_at > ${checkedAt.getTime()}
      and ${request.actor.workspaceId} = ${request.theme.workspaceId}
  )`;
}

async function actorIsAuthorized(
  database: SqliteDatabase,
  request: UpdateThemeRequest,
  checkedAt: Date,
) {
  if (request.actor.workspaceId !== request.theme.workspaceId) return false;
  return (await rows(database, sql`
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
      and session.expires_at > ${checkedAt.getTime()}
    limit 1
  `)).length === 1;
}

async function authoringIsOpen(database: SqliteDatabase, workspaceId: string) {
  const row = (await rows(database, sql`
    select writes_paused as writesPaused
    from workspace_authoring_controls
    where workspace_id = ${workspaceId}
    limit 1
  `))[0];
  if (!row || row.writesPaused === true || row.writesPaused === 1) {
    throw new AuthoringPausedError();
  }
}

async function classifyFailure(
  database: SqliteDatabase,
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

export function createSqliteThemeAuthoringRepository(
  database: SqliteDatabase,
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
          execute(authoringAssertion(request.theme.workspaceId, "sqlite")),
          read(sqliteAssertion(actorCondition(request, changedAt))),
          read(sqliteAssertion(sql`exists (
            select 1 from themes
            where workspace_id = ${request.theme.workspaceId}
              and id = ${request.theme.id}
              and version = ${request.expectedThemeVersion}
          )`)),
          execute(sql`
            update themes
            set name = ${request.theme.name},
                config = ${config},
                version = version + 1,
                updated_at = ${changedAt.getTime()}
            where workspace_id = ${request.theme.workspaceId}
              and id = ${request.theme.id}
              and version = ${request.expectedThemeVersion}
              and (
                name is not ${request.theme.name}
                or ${jsonChanged(sql`config`, config)}
              )
          `),
          read(themeSelection(request.theme.workspaceId)),
        ]);
        const storedRows = resultRows<DatabaseRow>(results[results.length - 1]);
        const storedRow = storedRows[0];
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
