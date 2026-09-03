// ABOUTME: Persists operator bootstrap and recovery transactions on Postgres and Neon.
// ABOUTME: Serializes identity setup while touching only workspace, control, member, session, and link rows.

import { sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type {
  OperatorBootstrapOutcome,
  OperatorBootstrapRecord,
  OperatorIdentityRepository,
  OperatorRecoveryOutcome,
  OperatorRecoveryRecord,
} from "@/auth/operator-identity";
import type * as schema from "@/db/schema/postgres";

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

async function transaction(
  database: PostgresDatabase,
  statements: readonly SQL[],
) {
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

const operatorLock = sql`select pg_advisory_xact_lock(1330663763, 1230192979)`;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Operator identity repository returned an invalid ${field}.`);
  }
  return value;
}

function bootstrapOutcome(value: unknown): Exclude<
  OperatorBootstrapOutcome,
  { outcome: "created" }
>["outcome"] {
  if (
    value === "already_bootstrapped" ||
    value === "ambiguous" ||
    value === "conflict" ||
    value === "not_empty" ||
    value === "not_found" ||
    value === "partial_state"
  ) {
    return value;
  }
  throw new Error("Operator identity repository returned an invalid bootstrap outcome.");
}

function recoveryOutcome(value: unknown): Exclude<
  OperatorRecoveryOutcome,
  { outcome: "created" }
>["outcome"] {
  if (
    value === "ambiguous" ||
    value === "collision" ||
    value === "not_found" ||
    value === "partial_state"
  ) {
    return value;
  }
  throw new Error("Operator identity repository returned an invalid recovery outcome.");
}

function insertWorkspaceStatement(request: OperatorBootstrapRecord) {
  const creation = request.workspaceCreation;
  const mayCreate = creation !== null;
  const creationId = creation?.id ?? "";
  const creationSlug = creation?.slug ?? "";
  const creationName = creation?.name ?? "";

  return sql`
    with matches as materialized (
      select id
      from workspaces
      where id = ${request.workspaceReference}
         or slug = ${request.workspaceReference}
    ), global_state as materialized (
      select
        (select count(*) from workspaces) as workspace_count,
        (select count(*) from workspace_authoring_controls) as control_count,
        (select count(*) from workspace_members) as member_count
    )
    insert into workspaces (id, slug, name, created_at, updated_at)
    select
      ${creationId},
      ${creationSlug},
      ${creationName},
      ${request.createdAt},
      ${request.createdAt}
    from global_state
    where ${mayCreate}
      and ${request.workspaceReference} in (${creationId}, ${creationSlug})
      and not exists(select 1 from matches)
      and workspace_count = 0
      and control_count = 0
      and member_count = 0
    returning id
  `;
}

function pauseInsertedWorkspaceStatement(request: OperatorBootstrapRecord) {
  const creation = request.workspaceCreation;
  return sql`
    update workspace_authoring_controls controls
    set writes_paused = true,
        generation = 0,
        changed_by_member_id = null,
        changed_at = ${request.createdAt}
    where ${creation !== null}
      and controls.workspace_id = ${creation?.id ?? ""}
      and controls.writes_paused = false
      and controls.generation = 0
      and controls.changed_by_member_id is null
      and exists (
        select 1
        from workspaces
        where id = controls.workspace_id
          and xmin::text = pg_current_xact_id()::text
      )
    returning controls.workspace_id
  `;
}

function insertBootstrapMemberStatement(request: OperatorBootstrapRecord) {
  const creation = request.workspaceCreation;
  const mayCreate = creation !== null;
  const creationId = creation?.id ?? "";
  const creationSlug = creation?.slug ?? "";
  const creationName = creation?.name ?? "";
  return sql`
    with matches as materialized (
      select id, slug, name
      from workspaces
      where id = ${request.workspaceReference}
         or slug = ${request.workspaceReference}
    )
    insert into workspace_members (
      id,
      workspace_id,
      normalized_email,
      display_name,
      role,
      status,
      password_salt,
      password_digest,
      password_iterations,
      created_by_member_id,
      created_at,
      updated_at,
      last_login_at
    )
    select
      ${request.memberId},
      matches.id,
      ${request.normalizedEmail},
      ${request.displayName},
      'administrator',
      'active',
      ${request.password.salt},
      ${request.password.digest},
      ${request.password.iterations},
      null,
      ${request.createdAt},
      ${request.createdAt},
      null
    from matches
    where (select count(*) from matches) = 1
      and (
        not ${mayCreate}
        or (
          matches.id = ${creationId}
          and matches.slug = ${creationSlug}
          and matches.name = ${creationName}
        )
      )
      and not exists (
        select 1 from workspace_members where workspace_id = matches.id
      )
      and exists (
        select 1
        from workspace_authoring_controls
        where workspace_id = matches.id and writes_paused = true
      )
    returning id as "memberId", workspace_id as "workspaceId"
  `;
}

function bootstrapStateStatement(request: OperatorBootstrapRecord) {
  return sql`
    select
      (select count(*) from workspaces
        where id = ${request.workspaceReference}
           or slug = ${request.workspaceReference}) as "workspaceCount",
      (select count(*) from workspaces) as "globalWorkspaceCount",
      (select count(*) from workspace_authoring_controls) as "globalControlCount",
      (select count(*) from workspace_members) as "globalMemberCount",
      (select count(*) from workspace_members members
        inner join workspaces on workspaces.id = members.workspace_id
        where workspaces.id = ${request.workspaceReference}
           or workspaces.slug = ${request.workspaceReference}) as "memberCount",
      (select count(*) from workspace_authoring_controls controls
        inner join workspaces on workspaces.id = controls.workspace_id
        where (workspaces.id = ${request.workspaceReference}
            or workspaces.slug = ${request.workspaceReference})
          and controls.writes_paused = true) as "pausedControlCount"
  `;
}

async function bootstrap(
  database: PostgresDatabase,
  request: OperatorBootstrapRecord,
): Promise<OperatorBootstrapOutcome> {
  const results = await transaction(database, [
    operatorLock,
    insertWorkspaceStatement(request),
    pauseInsertedWorkspaceStatement(request),
    insertBootstrapMemberStatement(request),
    bootstrapStateStatement(request),
  ]);
  const created = resultRows<DatabaseRow>(results[3])[0];
  if (created) {
    return Object.freeze({
      memberId: text(created.memberId, "member ID"),
      outcome: "created" as const,
      workspaceCreated: resultRows<DatabaseRow>(results[1]).length === 1,
      workspaceId: text(created.workspaceId, "workspace ID"),
    });
  }

  const state = resultRows<DatabaseRow>(results[4])[0];
  if (!state) throw new Error("Operator identity repository returned no bootstrap state.");
  const workspaceCount = count(state.workspaceCount, "workspace count");
  const globalWorkspaceCount = count(
    state.globalWorkspaceCount,
    "global workspace count",
  );
  const globalControlCount = count(state.globalControlCount, "global control count");
  const globalMemberCount = count(state.globalMemberCount, "global member count");
  const memberCount = count(state.memberCount, "member count");
  const pausedControlCount = count(state.pausedControlCount, "paused control count");
  if (workspaceCount > 1) return Object.freeze({ outcome: "ambiguous" });
  if (workspaceCount === 1 && memberCount > 0) {
    return Object.freeze({ outcome: "already_bootstrapped" });
  }
  if (workspaceCount === 1 || pausedControlCount > 0) {
    return Object.freeze({ outcome: "partial_state" });
  }
  if (!request.workspaceCreation) return Object.freeze({ outcome: "not_found" });
  if (globalWorkspaceCount || globalControlCount || globalMemberCount) {
    return Object.freeze({ outcome: "not_empty" });
  }
  return Object.freeze({ outcome: bootstrapOutcome("conflict") });
}

function recoveryCandidateStatement(request: OperatorRecoveryRecord) {
  const target = request.target;
  const targetField =
    target.kind === "credential_reset"
      ? target.memberReference.field === "id"
        ? sql`members.id`
        : sql`members.normalized_email`
      : sql`members.id`;
  const targetValue =
    target.kind === "credential_reset" ? target.memberReference.value : "";
  const email = target.kind === "invite" ? target.normalizedEmail : "";

  return sql`
    with matches as materialized (
      select id
      from workspaces
      where id = ${request.workspaceReference}
         or slug = ${request.workspaceReference}
    ), target_member as materialized (
      select members.id, members.workspace_id, members.normalized_email
      from workspace_members members
      inner join matches on matches.id = members.workspace_id
      where ${target.kind === "credential_reset"}
        and ${targetField} = ${targetValue}
        and members.role = 'administrator'
        and members.status = 'active'
    )
    insert into member_invitations (
      id,
      workspace_id,
      kind,
      normalized_email,
      target_role,
      member_id,
      token_digest,
      created_by_member_id,
      created_at,
      expires_at,
      accepted_at,
      revoked_at
    )
    select
      ${request.recordId},
      matches.id,
      ${target.kind},
      case
        when ${target.kind === "invite"} then ${email}
        else (select normalized_email from target_member limit 1)
      end,
      case when ${target.kind === "invite"} then 'administrator' else null end,
      case
        when ${target.kind === "credential_reset"}
          then (select id from target_member limit 1)
        else null
      end,
      ${request.tokenDigest},
      null,
      ${request.createdAt},
      ${request.expiresAt},
      null,
      ${request.createdAt}
    from matches
    where (select count(*) from matches) = 1
      and exists (
        select 1 from workspace_authoring_controls
        where workspace_id = matches.id
      )
      and (
        (
          ${target.kind === "invite"}
          and not exists (
            select 1 from workspace_members where workspace_id = matches.id
          )
        )
        or (
          ${target.kind === "credential_reset"}
          and (select count(*) from target_member) = 1
        )
      )
    on conflict do nothing
    returning workspace_id
  `;
}

function exactCandidate(request: OperatorRecoveryRecord) {
  return sql`
    id = ${request.recordId}
    and kind = ${request.target.kind}
    and token_digest = ${request.tokenDigest}
    and created_by_member_id is null
    and created_at = ${request.createdAt}
    and expires_at = ${request.expiresAt}
    and accepted_at is null
  `;
}

function revokePriorStatement(request: OperatorRecoveryRecord) {
  const candidate = exactCandidate(request);
  const targetMatch =
    request.target.kind === "invite"
      ? sql`normalized_email = ${request.target.normalizedEmail}`
      : sql`member_id = (
          select member_id from member_invitations where ${candidate}
        )`;
  return sql`
    update member_invitations
    set revoked_at = greatest(created_at, ${request.createdAt})
    where kind = ${request.target.kind}
      and ${targetMatch}
      and accepted_at is null
      and revoked_at is null
      and id <> ${request.recordId}
      and workspace_id = (
        select workspace_id from member_invitations where ${candidate}
      )
    returning id
  `;
}

function activateCandidateStatement(request: OperatorRecoveryRecord) {
  return sql`
    update member_invitations
    set revoked_at = null
    where ${exactCandidate(request)}
      and revoked_at = ${request.createdAt}
    returning workspace_id
  `;
}

function revokeRecoverySessionsStatement(request: OperatorRecoveryRecord) {
  if (request.target.kind === "invite") return sql`select 1 where false`;
  return sql`
    update admin_sessions
    set revoked_at = greatest(created_at, ${request.createdAt})
    where workspace_id = (
        select workspace_id
        from member_invitations
        where ${exactCandidate(request)} and revoked_at is null
      )
      and member_id = (
        select member_id
        from member_invitations
        where ${exactCandidate(request)} and revoked_at is null
      )
      and revoked_at is null
    returning id
  `;
}

function recoveryStateStatement(request: OperatorRecoveryRecord) {
  const target = request.target;
  const targetField =
    target.kind === "credential_reset"
      ? target.memberReference.field === "id"
        ? sql`members.id`
        : sql`members.normalized_email`
      : sql`members.id`;
  const targetValue =
    target.kind === "credential_reset" ? target.memberReference.value : "";
  return sql`
    with matches as materialized (
      select id
      from workspaces
      where id = ${request.workspaceReference}
         or slug = ${request.workspaceReference}
    )
    select
      (select count(*) from matches) as "workspaceCount",
      (select count(*) from workspace_authoring_controls controls
        inner join matches on matches.id = controls.workspace_id) as "controlCount",
      (select count(*) from workspace_members members
        inner join matches on matches.id = members.workspace_id) as "memberCount",
      (select count(*) from workspace_members members
        inner join matches on matches.id = members.workspace_id
        where ${target.kind === "credential_reset"}
          and ${targetField} = ${targetValue}
          and members.role = 'administrator'
          and members.status = 'active') as "targetCount"
  `;
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Operator identity repository returned an invalid ${field}.`);
  }
  return parsed;
}

async function issueRecovery(
  database: PostgresDatabase,
  request: OperatorRecoveryRecord,
): Promise<OperatorRecoveryOutcome> {
  const results = await transaction(database, [
    operatorLock,
    recoveryCandidateStatement(request),
    revokePriorStatement(request),
    activateCandidateStatement(request),
    revokeRecoverySessionsStatement(request),
    recoveryStateStatement(request),
  ]);
  const activated = resultRows<DatabaseRow>(results[3])[0];
  if (activated) {
    return Object.freeze({
      outcome: "created" as const,
      workspaceId: text(activated.workspace_id, "workspace ID"),
    });
  }

  const state = resultRows<DatabaseRow>(results[5])[0];
  if (!state) throw new Error("Operator identity repository returned no recovery state.");
  const workspaceCount = count(state.workspaceCount, "workspace count");
  const controlCount = count(state.controlCount, "control count");
  const memberCount = count(state.memberCount, "member count");
  const targetCount = count(state.targetCount, "target count");
  let outcome: ReturnType<typeof recoveryOutcome>;
  if (workspaceCount === 0) outcome = "not_found";
  else if (workspaceCount > 1) outcome = "ambiguous";
  else if (controlCount !== 1) outcome = "partial_state";
  else if (request.target.kind === "invite" && memberCount !== 0) {
    outcome = "partial_state";
  } else if (request.target.kind === "credential_reset" && targetCount !== 1) {
    outcome = "not_found";
  } else {
    outcome = "collision";
  }
  return Object.freeze({ outcome: recoveryOutcome(outcome) });
}

async function revokeUndeliveredRecovery(
  database: PostgresDatabase,
  request: OperatorRecoveryRecord,
): Promise<void> {
  const results = await transaction(database, [
    operatorLock,
    sql`
      update member_invitations
      set revoked_at = greatest(created_at, ${request.createdAt})
      where ${exactCandidate(request)}
        and revoked_at is null
      returning id
    `,
    sql`
      select count(*) as "activeCount"
      from member_invitations
      where ${exactCandidate(request)}
        and revoked_at is null
    `,
  ]);
  const state = resultRows<DatabaseRow>(results[2])[0];
  if (!state || count(state.activeCount, "active recovery count") !== 0) {
    throw new Error("Operator identity repository could not revoke recovery.");
  }
}

export function createPostgresOperatorIdentityRepository(
  database: PostgresDatabase,
): OperatorIdentityRepository {
  return Object.freeze({
    bootstrap: (request: OperatorBootstrapRecord) => bootstrap(database, request),
    issueRecovery: (request: OperatorRecoveryRecord) =>
      issueRecovery(database, request),
    revokeUndeliveredRecovery: (request: OperatorRecoveryRecord) =>
      revokeUndeliveredRecovery(database, request),
  });
}
