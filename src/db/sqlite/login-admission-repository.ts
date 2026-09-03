// ABOUTME: Stores durable login admission windows for SQLite and Cloudflare D1.
// ABOUTME: Uses one write batch so source and workspace reservations cannot split.

import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import {
  isPrincipalLoginRiskElevated,
  loginAdmissionPolicy,
  type LoginAdmissionCompletion,
  type LoginAdmissionFailureState,
  type LoginAdmissionRejectionReason,
  type LoginAdmissionRepository,
  type LoginAdmissionReservation,
  type LoginAdmissionReservationResult,
} from "@/auth/login-admission";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | BetterSQLite3Database<typeof schema>
  | D1BackedDatabase;

type DatabaseRow = Readonly<Record<string, unknown>>;

type ReservationRow = DatabaseRow &
  Readonly<{
    accepted: number;
    reason: string | null;
    retryAfterAt: number | null;
  }>;

type FailureRow = DatabaseRow &
  Readonly<{
    blockedUntil: number | null;
    failureCount: number;
    principalRiskCount: number;
    valid: number;
  }>;

function isD1Database(database: SqliteDatabase): database is D1BackedDatabase {
  return "batch" in database && "$client" in database;
}

function d1Statement(database: D1BackedDatabase, statement: SQL) {
  const query = database.run(statement).getQuery();
  return database.$client.prepare(query.sql).bind(...query.params);
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

async function batch(
  database: SqliteDatabase,
  statements: readonly SQL[],
  rowStatementIndexes: readonly number[],
) {
  if (isD1Database(database)) {
    return database.$client.batch(
      statements.map((statement) => d1Statement(database, statement)),
    );
  }
  return database.transaction((connection) =>
    statements.map((statement, index) => {
      if (rowStatementIndexes.includes(index)) {
        return connection.all<DatabaseRow>(statement);
      }
      connection.run(statement);
      return [];
    }),
  );
}

function cleanup(workspaceId: string, expiredAt: number) {
  return sql`
    delete from admin_login_windows
    where rowid in (
      select rowid
      from admin_login_windows
      where workspace_id = ${workspaceId}
        and expires_at <= ${expiredAt}
      order by expires_at, dimension, key_digest, window_started_at
      limit ${loginAdmissionPolicy.cleanupLimit}
    )
  `;
}

function reservationStatements(reservation: LoginAdmissionReservation) {
  const attemptedAt = reservation.attemptedAt.getTime();
  const sourceExpiresAt =
    attemptedAt + loginAdmissionPolicy.sourceAttemptWindowMilliseconds;
  const workspaceExpiresAt =
    attemptedAt + loginAdmissionPolicy.workspaceAttemptWindowMilliseconds;
  const pairActiveCount = sql`
    select count(*)
    from admin_login_windows
    where workspace_id = ${reservation.workspaceId}
      and dimension = 'source_principal'
      and key_digest in (
        ${reservation.current.sourcePrincipal},
        ${reservation.previous.sourcePrincipal}
      )
      and expires_at > ${attemptedAt}
  `;

  const sourceUpdate = sql`
    update admin_login_windows
    set count = count + 1,
        blocked_until = ${attemptedAt}
    where rowid = (
      select rowid
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'source'
        and key_digest in (
          ${reservation.current.source},
          ${reservation.previous.source}
        )
        and expires_at > ${attemptedAt}
      order by window_started_at desc, key_digest desc
      limit 1
    )
      and (
        select count(*)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'source'
          and key_digest in (
            ${reservation.current.source},
            ${reservation.previous.source}
          )
          and expires_at > ${attemptedAt}
      ) = 1
      and (
        select coalesce(sum(count), 0)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'source'
          and key_digest in (
            ${reservation.current.source},
            ${reservation.previous.source}
          )
          and expires_at > ${attemptedAt}
      ) < ${loginAdmissionPolicy.sourceAttemptLimit}
      and (
        select count(*)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'workspace'
          and key_digest in (
            ${reservation.current.workspace},
            ${reservation.previous.workspace}
          )
          and expires_at > ${attemptedAt}
      ) <= 1
      and (
        select coalesce(sum(count), 0)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'workspace'
          and key_digest in (
            ${reservation.current.workspace},
            ${reservation.previous.workspace}
          )
          and expires_at > ${attemptedAt}
      ) < ${loginAdmissionPolicy.workspaceAttemptLimit}
      and (${pairActiveCount}) <= 1
      and not exists (
        select 1
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'source_principal'
          and key_digest in (
            ${reservation.current.sourcePrincipal},
            ${reservation.previous.sourcePrincipal}
          )
          and blocked_until > ${attemptedAt}
          and expires_at > ${attemptedAt}
      )
  `;

  const sourceInsert = sql`
    insert into admin_login_windows (
      workspace_id,
      dimension,
      key_digest,
      window_started_at,
      count,
      blocked_until,
      expires_at
    )
    select
      ${reservation.workspaceId},
      'source',
      ${reservation.current.source},
      ${attemptedAt},
      1,
      ${attemptedAt},
      ${sourceExpiresAt}
    where (
        select count(*)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'source'
          and key_digest in (
            ${reservation.current.source},
            ${reservation.previous.source}
          )
          and expires_at > ${attemptedAt}
      ) = 0
      and (
        select count(*)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'workspace'
          and key_digest in (
            ${reservation.current.workspace},
            ${reservation.previous.workspace}
          )
          and expires_at > ${attemptedAt}
      ) <= 1
      and (
        select coalesce(sum(count), 0)
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'workspace'
          and key_digest in (
            ${reservation.current.workspace},
            ${reservation.previous.workspace}
          )
          and expires_at > ${attemptedAt}
      ) < ${loginAdmissionPolicy.workspaceAttemptLimit}
      and (${pairActiveCount}) <= 1
      and not exists (
        select 1
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'source_principal'
          and key_digest in (
            ${reservation.current.sourcePrincipal},
            ${reservation.previous.sourcePrincipal}
          )
          and blocked_until > ${attemptedAt}
          and expires_at > ${attemptedAt}
      )
    on conflict do nothing
  `;

  const sourceMarker = sql`
    exists (
      select 1
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'source'
        and key_digest in (
          ${reservation.current.source},
          ${reservation.previous.source}
        )
        and expires_at > ${attemptedAt}
        and blocked_until = ${attemptedAt}
    )
  `;

  const workspaceUpdate = sql`
    update admin_login_windows
    set count = count + 1,
        blocked_until = ${attemptedAt}
    where rowid = (
      select rowid
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'workspace'
        and key_digest in (
          ${reservation.current.workspace},
          ${reservation.previous.workspace}
        )
        and expires_at > ${attemptedAt}
      order by window_started_at desc, key_digest desc
      limit 1
    )
      and ${sourceMarker}
  `;

  const workspaceInsert = sql`
    insert into admin_login_windows (
      workspace_id,
      dimension,
      key_digest,
      window_started_at,
      count,
      blocked_until,
      expires_at
    )
    select
      ${reservation.workspaceId},
      'workspace',
      ${reservation.current.workspace},
      ${attemptedAt},
      1,
      ${attemptedAt},
      ${workspaceExpiresAt}
    where ${sourceMarker}
      and not exists (
        select 1
        from admin_login_windows
        where workspace_id = ${reservation.workspaceId}
          and dimension = 'workspace'
          and key_digest in (
            ${reservation.current.workspace},
            ${reservation.previous.workspace}
          )
          and expires_at > ${attemptedAt}
      )
    on conflict do nothing
  `;

  const workspaceMarker = sql`
    exists (
      select 1
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'workspace'
        and key_digest in (
          ${reservation.current.workspace},
          ${reservation.previous.workspace}
        )
        and expires_at > ${attemptedAt}
        and blocked_until = ${attemptedAt}
    )
  `;

  const result = sql<ReservationRow>`
    select
      case when ${sourceMarker} and ${workspaceMarker} then 1 else 0 end
        as accepted,
      case
        when ${sourceMarker} and ${workspaceMarker} then null
        when (
          select count(*)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'source'
            and key_digest in (
              ${reservation.current.source},
              ${reservation.previous.source}
            )
            and expires_at > ${attemptedAt}
        ) > 1 then 'integrity'
        when (
          select count(*)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'workspace'
            and key_digest in (
              ${reservation.current.workspace},
              ${reservation.previous.workspace}
            )
            and expires_at > ${attemptedAt}
        ) > 1 then 'integrity'
        when (${pairActiveCount}) > 1 then 'integrity'
        when exists (
          select 1
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'source_principal'
            and key_digest in (
              ${reservation.current.sourcePrincipal},
              ${reservation.previous.sourcePrincipal}
            )
            and blocked_until > ${attemptedAt}
            and expires_at > ${attemptedAt}
        ) then 'source_principal'
        when (
          select coalesce(sum(count), 0)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'workspace'
            and key_digest in (
              ${reservation.current.workspace},
              ${reservation.previous.workspace}
            )
            and expires_at > ${attemptedAt}
        ) >= ${loginAdmissionPolicy.workspaceAttemptLimit} then 'workspace'
        else 'source'
      end as reason,
      case
        when ${sourceMarker} and ${workspaceMarker} then null
        when (
          select count(*)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension in ('source', 'workspace')
            and (
              key_digest in (
                ${reservation.current.source},
                ${reservation.previous.source}
              )
              or key_digest in (
                ${reservation.current.workspace},
                ${reservation.previous.workspace}
              )
            )
            and expires_at > ${attemptedAt}
          group by dimension
          having count(*) > 1
          limit 1
        ) is not null then ${workspaceExpiresAt}
        when (${pairActiveCount}) > 1 then ${workspaceExpiresAt}
        when exists (
          select 1
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'source_principal'
            and key_digest in (
              ${reservation.current.sourcePrincipal},
              ${reservation.previous.sourcePrincipal}
            )
            and blocked_until > ${attemptedAt}
            and expires_at > ${attemptedAt}
        ) then (
          select max(blocked_until)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'source_principal'
            and key_digest in (
              ${reservation.current.sourcePrincipal},
              ${reservation.previous.sourcePrincipal}
            )
            and blocked_until > ${attemptedAt}
            and expires_at > ${attemptedAt}
        )
        when (
          select coalesce(sum(count), 0)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'workspace'
            and key_digest in (
              ${reservation.current.workspace},
              ${reservation.previous.workspace}
            )
            and expires_at > ${attemptedAt}
        ) >= ${loginAdmissionPolicy.workspaceAttemptLimit} then (
          select min(expires_at)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'workspace'
            and key_digest in (
              ${reservation.current.workspace},
              ${reservation.previous.workspace}
            )
            and expires_at > ${attemptedAt}
        )
        else (
          select min(expires_at)
          from admin_login_windows
          where workspace_id = ${reservation.workspaceId}
            and dimension = 'source'
            and key_digest in (
              ${reservation.current.source},
              ${reservation.previous.source}
            )
            and expires_at > ${attemptedAt}
        )
      end as "retryAfterAt"
  `;

  const compensateSource = sql`
    update admin_login_windows
    set count = count - 1,
        blocked_until = null
    where workspace_id = ${reservation.workspaceId}
      and dimension = 'source'
      and key_digest in (
        ${reservation.current.source},
        ${reservation.previous.source}
      )
      and expires_at > ${attemptedAt}
      and blocked_until = ${attemptedAt}
      and not ${workspaceMarker}
  `;

  const clearSourceMarker = sql`
    update admin_login_windows
    set blocked_until = null
    where workspace_id = ${reservation.workspaceId}
      and dimension = 'source'
      and key_digest in (
        ${reservation.current.source},
        ${reservation.previous.source}
      )
      and expires_at > ${attemptedAt}
      and blocked_until = ${attemptedAt}
  `;

  const clearWorkspaceMarker = sql`
    update admin_login_windows
    set blocked_until = null
    where workspace_id = ${reservation.workspaceId}
      and dimension = 'workspace'
      and key_digest in (
        ${reservation.current.workspace},
        ${reservation.previous.workspace}
      )
      and expires_at > ${attemptedAt}
      and blocked_until = ${attemptedAt}
  `;

  return [
    cleanup(reservation.workspaceId, attemptedAt),
    sourceUpdate,
    sourceInsert,
    workspaceUpdate,
    workspaceInsert,
    result,
    compensateSource,
    clearSourceMarker,
    clearWorkspaceMarker,
  ] as const;
}

function cooldownExpression(completion: LoginAdmissionCompletion) {
  const completedAt = completion.completedAt.getTime();
  const cooldowns = loginAdmissionPolicy.sourcePrincipalCooldownMilliseconds;
  return sql`
    case
      when coalesce(sum(count), 0) + 1 <= 1
        then ${completedAt + cooldowns[0]!}
      when coalesce(sum(count), 0) + 1 = 2
        then ${completedAt + cooldowns[1]!}
      when coalesce(sum(count), 0) + 1 = 3
        then ${completedAt + cooldowns[2]!}
      when coalesce(sum(count), 0) + 1 = 4
        then ${completedAt + cooldowns[3]!}
      else ${completedAt + cooldowns[4]!}
    end
  `;
}

function failureStatements(completion: LoginAdmissionCompletion) {
  const completedAt = completion.completedAt.getTime();
  const pairWindowStartedAfter =
    completedAt - loginAdmissionPolicy.sourcePrincipalFailureWindowMilliseconds;
  const principalWindowStartedAfter =
    completedAt - loginAdmissionPolicy.principalFailureWindowMilliseconds;
  const pairExpiresAt =
    completedAt + loginAdmissionPolicy.sourcePrincipalFailureWindowMilliseconds;
  const principalExpiresAt =
    completedAt + loginAdmissionPolicy.principalFailureWindowMilliseconds;

  const pairActiveCount = sql`
    select count(*)
    from admin_login_windows
    where workspace_id = ${completion.workspaceId}
      and dimension = 'source_principal'
      and key_digest in (
        ${completion.current.sourcePrincipal},
        ${completion.previous.sourcePrincipal}
      )
      and window_started_at > ${pairWindowStartedAfter}
  `;
  const principalActiveCount = sql`
    select count(*)
    from admin_login_windows
    where workspace_id = ${completion.workspaceId}
      and dimension = 'principal'
      and key_digest in (
        ${completion.current.principal},
        ${completion.previous.principal}
      )
      and window_started_at > ${principalWindowStartedAfter}
  `;
  const nextBlockedUntil = sql`
    select ${cooldownExpression(completion)}
    from admin_login_windows
    where workspace_id = ${completion.workspaceId}
      and dimension = 'source_principal'
      and key_digest in (
        ${completion.current.sourcePrincipal},
        ${completion.previous.sourcePrincipal}
      )
      and window_started_at > ${pairWindowStartedAfter}
  `;

  const pairUpdate = sql`
    update admin_login_windows
    set count = count + 1,
        blocked_until = (${nextBlockedUntil}),
        expires_at = max(expires_at, (${nextBlockedUntil}))
    where rowid = (
      select rowid
      from admin_login_windows
      where workspace_id = ${completion.workspaceId}
        and dimension = 'source_principal'
        and key_digest in (
          ${completion.current.sourcePrincipal},
          ${completion.previous.sourcePrincipal}
        )
        and window_started_at > ${pairWindowStartedAfter}
      order by window_started_at desc, key_digest desc
      limit 1
    )
      and (${pairActiveCount}) = 1
      and (${principalActiveCount}) <= 1
  `;
  const pairInsert = sql`
    insert into admin_login_windows (
      workspace_id,
      dimension,
      key_digest,
      window_started_at,
      count,
      blocked_until,
      expires_at
    )
    select
      ${completion.workspaceId},
      'source_principal',
      ${completion.current.sourcePrincipal},
      ${completedAt},
      1,
      ${completedAt + loginAdmissionPolicy.sourcePrincipalCooldownMilliseconds[0]!},
      ${pairExpiresAt}
    where (${pairActiveCount}) = 0
      and (${principalActiveCount}) <= 1
    on conflict do nothing
  `;
  const principalUpdate = sql`
    update admin_login_windows
    set count = count + 1
    where rowid = (
      select rowid
      from admin_login_windows
      where workspace_id = ${completion.workspaceId}
        and dimension = 'principal'
        and key_digest in (
          ${completion.current.principal},
          ${completion.previous.principal}
        )
        and window_started_at > ${principalWindowStartedAfter}
      order by window_started_at desc, key_digest desc
      limit 1
    )
      and (${principalActiveCount}) = 1
      and (${pairActiveCount}) = 1
  `;
  const principalInsert = sql`
    insert into admin_login_windows (
      workspace_id,
      dimension,
      key_digest,
      window_started_at,
      count,
      blocked_until,
      expires_at
    )
    select
      ${completion.workspaceId},
      'principal',
      ${completion.current.principal},
      ${completedAt},
      1,
      null,
      ${principalExpiresAt}
    where (${principalActiveCount}) = 0
      and (${pairActiveCount}) = 1
    on conflict do nothing
  `;
  const result = sql<FailureRow>`
    select
      case
        when (${pairActiveCount}) = 1
          and (${principalActiveCount}) = 1 then 1
        else 0
      end as valid,
      (
        select count
        from admin_login_windows
        where workspace_id = ${completion.workspaceId}
          and dimension = 'source_principal'
          and key_digest in (
            ${completion.current.sourcePrincipal},
            ${completion.previous.sourcePrincipal}
          )
          and window_started_at > ${pairWindowStartedAfter}
        order by window_started_at desc, key_digest desc
        limit 1
      ) as "failureCount",
      (
        select blocked_until
        from admin_login_windows
        where workspace_id = ${completion.workspaceId}
          and dimension = 'source_principal'
          and key_digest in (
            ${completion.current.sourcePrincipal},
            ${completion.previous.sourcePrincipal}
          )
          and window_started_at > ${pairWindowStartedAfter}
        order by window_started_at desc, key_digest desc
        limit 1
      ) as "blockedUntil",
      (
        select count
        from admin_login_windows
        where workspace_id = ${completion.workspaceId}
          and dimension = 'principal'
          and key_digest in (
            ${completion.current.principal},
            ${completion.previous.principal}
          )
          and window_started_at > ${principalWindowStartedAfter}
        order by window_started_at desc, key_digest desc
        limit 1
      ) as "principalRiskCount"
  `;

  return [
    cleanup(completion.workspaceId, completedAt),
    pairUpdate,
    pairInsert,
    principalUpdate,
    principalInsert,
    result,
  ] as const;
}

function clearFailureStatements(completion: LoginAdmissionCompletion) {
  const completedAt = completion.completedAt.getTime();
  return [
    cleanup(completion.workspaceId, completedAt),
    sql`
      delete from admin_login_windows
      where workspace_id = ${completion.workspaceId}
        and dimension = 'source_principal'
        and key_digest in (
          ${completion.current.sourcePrincipal},
          ${completion.previous.sourcePrincipal}
        )
      returning key_digest
    `,
  ] as const;
}

function date(value: number | null, field: string) {
  const parsed = new Date(value ?? Number.NaN);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Login admission returned an invalid ${field}.`);
  }
  return parsed;
}

function reservationResult(row: ReservationRow | undefined): LoginAdmissionReservationResult {
  if (row?.accepted === 1) return Object.freeze({ accepted: true as const });
  if (
    row?.accepted === 0 &&
    (row.reason === "integrity" ||
      row.reason === "source" ||
      row.reason === "source_principal" ||
      row.reason === "workspace")
  ) {
    return Object.freeze({
      accepted: false as const,
      reason: row.reason satisfies LoginAdmissionRejectionReason,
      retryAfterAt: date(row.retryAfterAt, "retry timestamp"),
    });
  }
  throw new Error("Login admission reservation failed.");
}

function failureResult(row: FailureRow | undefined): LoginAdmissionFailureState {
  if (
    row?.valid !== 1 ||
    !Number.isSafeInteger(row.failureCount) ||
    row.failureCount < 1 ||
    !Number.isSafeInteger(row.principalRiskCount) ||
    row.principalRiskCount < 1
  ) {
    throw new Error("Login admission failure state is inconsistent.");
  }
  return Object.freeze({
    blockedUntil: date(row.blockedUntil, "cooldown timestamp"),
    failureCount: row.failureCount,
    principalRiskCount: row.principalRiskCount,
    principalRiskElevated: isPrincipalLoginRiskElevated(row.principalRiskCount),
  });
}

async function reserve(
  database: SqliteDatabase,
  reservation: LoginAdmissionReservation,
) {
  const results = await batch(database, reservationStatements(reservation), [5]);
  return reservationResult(resultRows<ReservationRow>(results[5])[0]);
}

async function recordFailure(
  database: SqliteDatabase,
  completion: LoginAdmissionCompletion,
) {
  const results = await batch(database, failureStatements(completion), [5]);
  return failureResult(resultRows<FailureRow>(results.at(-1))[0]);
}

async function clearFailure(
  database: SqliteDatabase,
  completion: LoginAdmissionCompletion,
) {
  const results = await batch(database, clearFailureStatements(completion), [1]);
  return resultRows<DatabaseRow>(results.at(-1)).length;
}

export function createSqliteLoginAdmissionRepository(
  database: SqliteDatabase,
): LoginAdmissionRepository {
  const repository: LoginAdmissionRepository = {
    clearFailure: (completion) => clearFailure(database, completion),
    recordFailure: (completion) => recordFailure(database, completion),
    reserve: (reservation) => reserve(database, reservation),
  };
  return Object.freeze(repository);
}
