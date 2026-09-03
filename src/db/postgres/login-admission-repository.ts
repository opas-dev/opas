// ABOUTME: Stores durable login admission windows for Postgres and Neon.
// ABOUTME: Serializes each workspace so source and workspace reservations commit together.

import { sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

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
import type * as schema from "@/db/schema/postgres";

type PostgresDatabase =
  | NodePgDatabase<typeof schema>
  | NeonHttpDatabase<typeof schema>;

type DatabaseRow = Readonly<Record<string, unknown>>;

type ReservationRow = DatabaseRow &
  Readonly<{
    accepted: boolean;
    reason: string | null;
    retryAfterAt: Date | string | null;
  }>;

type FailureRow = DatabaseRow &
  Readonly<{
    blockedUntil: Date | string | null;
    failureCount: number;
    principalRiskCount: number;
    valid: boolean;
  }>;

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

async function batch(database: PostgresDatabase, statements: readonly SQL[]) {
  if (isNeonDatabase(database)) {
    const queries = statements.map((statement) => database.execute(statement));
    type Query = (typeof queries)[number];
    return database.batch(queries as [Query, ...Query[]]);
  }
  return database.transaction(async (transaction) => {
    const results = [];
    for (const statement of statements) {
      results.push(await transaction.execute(statement));
    }
    return results;
  });
}

function workspaceLock(workspaceId: string) {
  return sql`
    select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))
  `;
}

function cleanup(workspaceId: string, expiredAt: Date) {
  return sql`
    delete from admin_login_windows
    where ctid in (
      select ctid
      from admin_login_windows
      where workspace_id = ${workspaceId}
        and expires_at <= ${expiredAt}
      order by expires_at, dimension, key_digest, window_started_at
      limit ${loginAdmissionPolicy.cleanupLimit}
    )
  `;
}

function reservationStatement(reservation: LoginAdmissionReservation) {
  const sourceExpiresAt = new Date(
    reservation.attemptedAt.getTime() +
      loginAdmissionPolicy.sourceAttemptWindowMilliseconds,
  );
  const workspaceExpiresAt = new Date(
    reservation.attemptedAt.getTime() +
      loginAdmissionPolicy.workspaceAttemptWindowMilliseconds,
  );
  const integrityRetryAt = workspaceExpiresAt;

  return sql<ReservationRow>`
    with source_state as (
      select
        count(*)::integer as active_rows,
        coalesce(sum(count), 0)::integer as attempt_count,
        min(expires_at) as retry_after_at,
        (array_agg(key_digest order by window_started_at desc, key_digest desc))[1]
          as active_digest,
        (array_agg(window_started_at order by window_started_at desc, key_digest desc))[1]
          as active_started_at
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'source'
        and key_digest in (
          ${reservation.current.source},
          ${reservation.previous.source}
        )
        and expires_at > ${reservation.attemptedAt}
    ), workspace_state as (
      select
        count(*)::integer as active_rows,
        coalesce(sum(count), 0)::integer as attempt_count,
        min(expires_at) as retry_after_at,
        (array_agg(key_digest order by window_started_at desc, key_digest desc))[1]
          as active_digest,
        (array_agg(window_started_at order by window_started_at desc, key_digest desc))[1]
          as active_started_at
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'workspace'
        and key_digest in (
          ${reservation.current.workspace},
          ${reservation.previous.workspace}
        )
        and expires_at > ${reservation.attemptedAt}
    ), pair_state as (
      select
        count(*)::integer as active_rows,
        max(blocked_until) filter (
          where blocked_until > ${reservation.attemptedAt}
        ) as blocked_until
      from admin_login_windows
      where workspace_id = ${reservation.workspaceId}
        and dimension = 'source_principal'
        and key_digest in (
          ${reservation.current.sourcePrincipal},
          ${reservation.previous.sourcePrincipal}
        )
        and expires_at > ${reservation.attemptedAt}
    ), decision as (
      select
        source_state.active_rows as source_active_rows,
        source_state.active_digest as source_active_digest,
        source_state.active_started_at as source_active_started_at,
        source_state.attempt_count as source_attempt_count,
        source_state.retry_after_at as source_retry_after_at,
        workspace_state.active_rows as workspace_active_rows,
        workspace_state.active_digest as workspace_active_digest,
        workspace_state.active_started_at as workspace_active_started_at,
        workspace_state.attempt_count as workspace_attempt_count,
        workspace_state.retry_after_at as workspace_retry_after_at,
        pair_state.active_rows as pair_active_rows,
        pair_state.blocked_until,
        source_state.active_rows <= 1
          and workspace_state.active_rows <= 1
          and pair_state.active_rows <= 1
          and pair_state.blocked_until is null
          and source_state.attempt_count < ${loginAdmissionPolicy.sourceAttemptLimit}
          and workspace_state.attempt_count < ${loginAdmissionPolicy.workspaceAttemptLimit}
          as accepted
      from source_state, workspace_state, pair_state
    ), source_updated as (
      update admin_login_windows as windows
      set count = windows.count + 1
      from decision
      where decision.accepted
        and decision.source_active_rows = 1
        and windows.workspace_id = ${reservation.workspaceId}
        and windows.dimension = 'source'
        and windows.key_digest = decision.source_active_digest
        and windows.window_started_at = decision.source_active_started_at
      returning windows.key_digest
    ), source_inserted as (
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
        ${reservation.attemptedAt},
        1,
        null,
        ${sourceExpiresAt}
      from decision
      where decision.accepted
        and decision.source_active_rows = 0
      on conflict do nothing
      returning key_digest
    ), workspace_updated as (
      update admin_login_windows as windows
      set count = windows.count + 1
      from decision
      where decision.accepted
        and decision.workspace_active_rows = 1
        and windows.workspace_id = ${reservation.workspaceId}
        and windows.dimension = 'workspace'
        and windows.key_digest = decision.workspace_active_digest
        and windows.window_started_at = decision.workspace_active_started_at
      returning windows.key_digest
    ), workspace_inserted as (
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
        ${reservation.attemptedAt},
        1,
        null,
        ${workspaceExpiresAt}
      from decision
      where decision.accepted
        and decision.workspace_active_rows = 0
      on conflict do nothing
      returning key_digest
    )
    select
      decision.accepted as accepted,
      case
        when decision.accepted then null
        when decision.source_active_rows > 1
          or decision.workspace_active_rows > 1
          or decision.pair_active_rows > 1 then 'integrity'
        when decision.blocked_until is not null then 'source_principal'
        when decision.workspace_attempt_count >= ${loginAdmissionPolicy.workspaceAttemptLimit}
          then 'workspace'
        else 'source'
      end as reason,
      case
        when decision.accepted then null
        when decision.source_active_rows > 1
          or decision.workspace_active_rows > 1
          or decision.pair_active_rows > 1 then ${integrityRetryAt}
        when decision.blocked_until is not null then decision.blocked_until
        when decision.workspace_attempt_count >= ${loginAdmissionPolicy.workspaceAttemptLimit}
          then decision.workspace_retry_after_at
        else decision.source_retry_after_at
      end as "retryAfterAt"
    from decision
  `;
}

function failureStatement(completion: LoginAdmissionCompletion) {
  const pairWindowStartedAfter = new Date(
    completion.completedAt.getTime() -
      loginAdmissionPolicy.sourcePrincipalFailureWindowMilliseconds,
  );
  const principalWindowStartedAfter = new Date(
    completion.completedAt.getTime() -
      loginAdmissionPolicy.principalFailureWindowMilliseconds,
  );
  const pairExpiresAt = new Date(
    completion.completedAt.getTime() +
      loginAdmissionPolicy.sourcePrincipalFailureWindowMilliseconds,
  );
  const principalExpiresAt = new Date(
    completion.completedAt.getTime() +
      loginAdmissionPolicy.principalFailureWindowMilliseconds,
  );
  const cooldowns = loginAdmissionPolicy.sourcePrincipalCooldownMilliseconds.map(
    (milliseconds) => new Date(completion.completedAt.getTime() + milliseconds),
  );

  return sql<FailureRow>`
    with pair_state as (
      select
        count(*)::integer as active_rows,
        coalesce(sum(count), 0)::integer as failure_count,
        (array_agg(key_digest order by window_started_at desc, key_digest desc))[1]
          as active_digest,
        (array_agg(window_started_at order by window_started_at desc, key_digest desc))[1]
          as active_started_at
      from admin_login_windows
      where workspace_id = ${completion.workspaceId}
        and dimension = 'source_principal'
        and key_digest in (
          ${completion.current.sourcePrincipal},
          ${completion.previous.sourcePrincipal}
        )
        and window_started_at > ${pairWindowStartedAfter}
    ), principal_state as (
      select
        count(*)::integer as active_rows,
        coalesce(sum(count), 0)::integer as failure_count,
        (array_agg(key_digest order by window_started_at desc, key_digest desc))[1]
          as active_digest,
        (array_agg(window_started_at order by window_started_at desc, key_digest desc))[1]
          as active_started_at
      from admin_login_windows
      where workspace_id = ${completion.workspaceId}
        and dimension = 'principal'
        and key_digest in (
          ${completion.current.principal},
          ${completion.previous.principal}
        )
        and window_started_at > ${principalWindowStartedAfter}
    ), decision as (
      select
        pair_state.*,
        principal_state.active_rows as principal_active_rows,
        principal_state.failure_count as principal_failure_count,
        principal_state.active_digest as principal_active_digest,
        principal_state.active_started_at as principal_active_started_at,
        pair_state.active_rows <= 1 and principal_state.active_rows <= 1 as valid,
        case
          when pair_state.failure_count + 1 <= 1 then ${cooldowns[0]}::timestamptz
          when pair_state.failure_count + 1 = 2 then ${cooldowns[1]}::timestamptz
          when pair_state.failure_count + 1 = 3 then ${cooldowns[2]}::timestamptz
          when pair_state.failure_count + 1 = 4 then ${cooldowns[3]}::timestamptz
          else ${cooldowns[4]}::timestamptz
        end as next_blocked_until
      from pair_state, principal_state
    ), pair_updated as (
      update admin_login_windows as windows
      set
        count = windows.count + 1,
        blocked_until = decision.next_blocked_until,
        expires_at = greatest(windows.expires_at, decision.next_blocked_until)
      from decision
      where decision.valid
        and decision.active_rows = 1
        and windows.workspace_id = ${completion.workspaceId}
        and windows.dimension = 'source_principal'
        and windows.key_digest = decision.active_digest
        and windows.window_started_at = decision.active_started_at
      returning windows.count as failure_count, windows.blocked_until
    ), pair_inserted as (
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
        ${completion.completedAt},
        1,
        decision.next_blocked_until,
        ${pairExpiresAt}
      from decision
      where decision.valid
        and decision.active_rows = 0
      on conflict do nothing
      returning count as failure_count, blocked_until
    ), principal_updated as (
      update admin_login_windows as windows
      set count = windows.count + 1
      from decision
      where decision.valid
        and decision.principal_active_rows = 1
        and windows.workspace_id = ${completion.workspaceId}
        and windows.dimension = 'principal'
        and windows.key_digest = decision.principal_active_digest
        and windows.window_started_at = decision.principal_active_started_at
      returning windows.count as failure_count
    ), principal_inserted as (
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
        ${completion.completedAt},
        1,
        null,
        ${principalExpiresAt}
      from decision
      where decision.valid
        and decision.principal_active_rows = 0
      on conflict do nothing
      returning count as failure_count
    )
    select
      decision.valid as valid,
      coalesce(
        (select failure_count from pair_updated),
        (select failure_count from pair_inserted),
        0
      )::integer as "failureCount",
      coalesce(
        (select blocked_until from pair_updated),
        (select blocked_until from pair_inserted)
      ) as "blockedUntil",
      coalesce(
        (select failure_count from principal_updated),
        (select failure_count from principal_inserted),
        0
      )::integer as "principalRiskCount"
    from decision
  `;
}

function clearFailureStatement(completion: LoginAdmissionCompletion) {
  return sql`
    delete from admin_login_windows
    where workspace_id = ${completion.workspaceId}
      and dimension = 'source_principal'
      and key_digest in (
        ${completion.current.sourcePrincipal},
        ${completion.previous.sourcePrincipal}
      )
    returning key_digest
  `;
}

function date(value: Date | string | null, field: string) {
  const parsed = value === null ? new Date(Number.NaN) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Login admission returned an invalid ${field}.`);
  }
  return parsed;
}

function reservationResult(row: ReservationRow | undefined): LoginAdmissionReservationResult {
  if (row?.accepted === true) return Object.freeze({ accepted: true as const });
  if (
    row?.accepted === false &&
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
    row?.valid !== true ||
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
  database: PostgresDatabase,
  reservation: LoginAdmissionReservation,
) {
  const results = await batch(database, [
    workspaceLock(reservation.workspaceId),
    cleanup(reservation.workspaceId, reservation.attemptedAt),
    reservationStatement(reservation),
  ]);
  return reservationResult(resultRows<ReservationRow>(results.at(-1))[0]);
}

async function recordFailure(
  database: PostgresDatabase,
  completion: LoginAdmissionCompletion,
) {
  const results = await batch(database, [
    workspaceLock(completion.workspaceId),
    cleanup(completion.workspaceId, completion.completedAt),
    failureStatement(completion),
  ]);
  return failureResult(resultRows<FailureRow>(results.at(-1))[0]);
}

async function clearFailure(
  database: PostgresDatabase,
  completion: LoginAdmissionCompletion,
) {
  const results = await batch(database, [
    workspaceLock(completion.workspaceId),
    cleanup(completion.workspaceId, completion.completedAt),
    clearFailureStatement(completion),
  ]);
  return resultRows<DatabaseRow>(results.at(-1)).length;
}

export function createPostgresLoginAdmissionRepository(
  database: PostgresDatabase,
): LoginAdmissionRepository {
  const repository: LoginAdmissionRepository = {
    clearFailure: (completion) => clearFailure(database, completion),
    recordFailure: (completion) => recordFailure(database, completion),
    reserve: (reservation) => reserve(database, reservation),
  };
  return Object.freeze(repository);
}
