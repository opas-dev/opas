// ABOUTME: Persists operator bootstrap and recovery transactions on SQLite and Cloudflare D1.
// ABOUTME: Uses one atomic batch while touching only workspace, control, member, session, and link rows.

import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type {
  OperatorBootstrapOutcome,
  OperatorBootstrapRecord,
  OperatorIdentityRepository,
  OperatorRecoveryOutcome,
  OperatorRecoveryRecord,
} from "@/auth/operator-identity";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | BetterSQLite3Database<typeof schema>
  | D1BackedDatabase;

type DatabaseRow = Readonly<Record<string, unknown>>;

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

async function batch(database: SqliteDatabase, statements: readonly SQL[]) {
  if (isD1Database(database)) {
    return database.$client.batch(
      statements.map((statement) => d1Statement(database, statement)),
    );
  }
  return database.transaction((connection) =>
    statements.map((statement) => connection.all<DatabaseRow>(statement)),
  );
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Operator identity repository returned an invalid ${field}.`);
  }
  return value;
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Operator identity repository returned an invalid ${field}.`);
  }
  return parsed;
}

function bootstrapStatements(request: OperatorBootstrapRecord): readonly SQL[] {
  const creation = request.workspaceCreation;
  const mayCreate = creation !== null ? 1 : 0;
  const creationId = creation?.id ?? "";
  const creationSlug = creation?.slug ?? "";
  const creationName = creation?.name ?? "";
  return [
    sql`
      insert into workspaces (id, slug, name, created_at, updated_at)
      select
        ${creationId},
        ${creationSlug},
        ${creationName},
        ${request.createdAt.getTime()},
        ${request.createdAt.getTime()}
      where ${mayCreate}
        and ${request.workspaceReference} in (${creationId}, ${creationSlug})
        and not exists (
          select 1 from workspaces
          where id = ${request.workspaceReference}
             or slug = ${request.workspaceReference}
        )
        and not exists(select 1 from workspaces)
        and not exists(select 1 from workspace_authoring_controls)
        and not exists(select 1 from workspace_members)
      returning id
    `,
    sql`
      update workspace_authoring_controls
      set writes_paused = 1,
          generation = 0,
          changed_by_member_id = null,
          changed_at = ${request.createdAt.getTime()}
      where workspace_id = ${creationId}
        and writes_paused = 0
        and generation = 0
        and changed_by_member_id is null
        and ${mayCreate}
        and changes() = 1
      returning workspace_id
    `,
    sql`
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
        workspaces.id,
        ${request.normalizedEmail},
        ${request.displayName},
        'administrator',
        'active',
        ${request.password.salt},
        ${request.password.digest},
        ${request.password.iterations},
        null,
        ${request.createdAt.getTime()},
        ${request.createdAt.getTime()},
        null
      from workspaces
      where (workspaces.id = ${request.workspaceReference}
          or workspaces.slug = ${request.workspaceReference})
        and (
          select count(*) from workspaces matches
          where matches.id = ${request.workspaceReference}
             or matches.slug = ${request.workspaceReference}
        ) = 1
        and (
          not ${mayCreate}
          or (
            workspaces.id = ${creationId}
            and workspaces.slug = ${creationSlug}
            and workspaces.name = ${creationName}
          )
        )
        and not exists (
          select 1 from workspace_members where workspace_id = workspaces.id
        )
        and exists (
          select 1
          from workspace_authoring_controls
          where workspace_id = workspaces.id and writes_paused = 1
        )
      returning id as "memberId", workspace_id as "workspaceId"
    `,
    sql`
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
            and controls.writes_paused = 1) as "pausedControlCount"
    `,
  ];
}

async function bootstrap(
  database: SqliteDatabase,
  request: OperatorBootstrapRecord,
): Promise<OperatorBootstrapOutcome> {
  const results = await batch(database, bootstrapStatements(request));
  const created = resultRows<DatabaseRow>(results[2])[0];
  if (created) {
    return Object.freeze({
      memberId: text(created.memberId, "member ID"),
      outcome: "created" as const,
      workspaceCreated: resultRows<DatabaseRow>(results[0]).length === 1,
      workspaceId: text(created.workspaceId, "workspace ID"),
    });
  }

  const state = resultRows<DatabaseRow>(results[3])[0];
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
  return Object.freeze({ outcome: "conflict" });
}

function recoveryTargetCondition(request: OperatorRecoveryRecord) {
  if (request.target.kind === "invite") {
    return sql`not exists (
      select 1 from workspace_members where workspace_id = workspaces.id
    )`;
  }
  const field =
    request.target.memberReference.field === "id"
      ? sql`members.id`
      : sql`members.normalized_email`;
  return sql`(
    select count(*)
    from workspace_members members
    where members.workspace_id = workspaces.id
      and ${field} = ${request.target.memberReference.value}
      and members.role = 'administrator'
      and members.status = 'active'
  ) = 1`;
}

function candidateEmail(request: OperatorRecoveryRecord) {
  if (request.target.kind === "invite") return sql`${request.target.normalizedEmail}`;
  const field =
    request.target.memberReference.field === "id"
      ? sql`members.id`
      : sql`members.normalized_email`;
  return sql`(
    select members.normalized_email
    from workspace_members members
    where members.workspace_id = workspaces.id
      and ${field} = ${request.target.memberReference.value}
      and members.role = 'administrator'
      and members.status = 'active'
    limit 1
  )`;
}

function candidateMemberId(request: OperatorRecoveryRecord) {
  if (request.target.kind === "invite") return sql`null`;
  const field =
    request.target.memberReference.field === "id"
      ? sql`members.id`
      : sql`members.normalized_email`;
  return sql`(
    select members.id
    from workspace_members members
    where members.workspace_id = workspaces.id
      and ${field} = ${request.target.memberReference.value}
      and members.role = 'administrator'
      and members.status = 'active'
    limit 1
  )`;
}

function candidateTargetRole(request: OperatorRecoveryRecord) {
  return request.target.kind === "invite" ? sql`'administrator'` : sql`null`;
}

function exactCandidate(request: OperatorRecoveryRecord) {
  return sql`
    id = ${request.recordId}
    and kind = ${request.target.kind}
    and token_digest = ${request.tokenDigest}
    and created_by_member_id is null
    and created_at = ${request.createdAt.getTime()}
    and expires_at = ${request.expiresAt.getTime()}
    and accepted_at is null
  `;
}

function recoveryStatements(request: OperatorRecoveryRecord): readonly SQL[] {
  const isReset = request.target.kind === "credential_reset" ? 1 : 0;
  const targetMatch =
    request.target.kind === "invite"
      ? sql`normalized_email = ${request.target.normalizedEmail}`
      : sql`member_id = (
          select member_id from member_invitations where ${exactCandidate(request)}
        )`;
  const resetField =
    request.target.kind === "credential_reset"
      ? request.target.memberReference.field === "id"
        ? sql`members.id`
        : sql`members.normalized_email`
      : sql`members.id`;
  const resetValue =
    request.target.kind === "credential_reset"
      ? request.target.memberReference.value
      : "";

  return [
    sql`
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
        workspaces.id,
        ${request.target.kind},
        ${candidateEmail(request)},
        ${candidateTargetRole(request)},
        ${candidateMemberId(request)},
        ${request.tokenDigest},
        null,
        ${request.createdAt.getTime()},
        ${request.expiresAt.getTime()},
        null,
        ${request.createdAt.getTime()}
      from workspaces
      where (workspaces.id = ${request.workspaceReference}
          or workspaces.slug = ${request.workspaceReference})
        and (
          select count(*) from workspaces matches
          where matches.id = ${request.workspaceReference}
             or matches.slug = ${request.workspaceReference}
        ) = 1
        and exists (
          select 1 from workspace_authoring_controls
          where workspace_id = workspaces.id
        )
        and ${recoveryTargetCondition(request)}
      on conflict do nothing
      returning workspace_id as "workspaceId"
    `,
    sql`
      update member_invitations
      set revoked_at = max(created_at, ${request.createdAt.getTime()})
      where kind = ${request.target.kind}
        and ${targetMatch}
        and accepted_at is null
        and revoked_at is null
        and id <> ${request.recordId}
        and workspace_id = (
          select workspace_id from member_invitations where ${exactCandidate(request)}
        )
      returning id
    `,
    sql`
      update member_invitations
      set revoked_at = null
      where ${exactCandidate(request)}
        and revoked_at = ${request.createdAt.getTime()}
      returning workspace_id as "workspaceId"
    `,
    request.target.kind === "credential_reset"
      ? sql`
          update admin_sessions
          set revoked_at = max(created_at, ${request.createdAt.getTime()})
          where workspace_id = (
              select workspace_id from member_invitations
              where ${exactCandidate(request)} and revoked_at is null
            )
            and member_id = (
              select member_id from member_invitations
              where ${exactCandidate(request)} and revoked_at is null
            )
            and revoked_at is null
          returning id
        `
      : sql`select 1 where false`,
    sql`
      select
        (select count(*) from workspaces
          where id = ${request.workspaceReference}
             or slug = ${request.workspaceReference}) as "workspaceCount",
        (select count(*) from workspace_authoring_controls controls
          inner join workspaces on workspaces.id = controls.workspace_id
          where workspaces.id = ${request.workspaceReference}
             or workspaces.slug = ${request.workspaceReference}) as "controlCount",
        (select count(*) from workspace_members members
          inner join workspaces on workspaces.id = members.workspace_id
          where workspaces.id = ${request.workspaceReference}
             or workspaces.slug = ${request.workspaceReference}) as "memberCount",
        (select count(*) from workspace_members members
          inner join workspaces on workspaces.id = members.workspace_id
          where (workspaces.id = ${request.workspaceReference}
              or workspaces.slug = ${request.workspaceReference})
            and ${isReset}
            and ${resetField} = ${resetValue}
            and members.role = 'administrator'
            and members.status = 'active') as "targetCount"
    `,
  ];
}

async function issueRecovery(
  database: SqliteDatabase,
  request: OperatorRecoveryRecord,
): Promise<OperatorRecoveryOutcome> {
  const results = await batch(database, recoveryStatements(request));
  const activated = resultRows<DatabaseRow>(results[2])[0];
  if (activated) {
    return Object.freeze({
      outcome: "created" as const,
      workspaceId: text(activated.workspaceId, "workspace ID"),
    });
  }

  const state = resultRows<DatabaseRow>(results[4])[0];
  if (!state) throw new Error("Operator identity repository returned no recovery state.");
  const workspaceCount = count(state.workspaceCount, "workspace count");
  const controlCount = count(state.controlCount, "control count");
  const memberCount = count(state.memberCount, "member count");
  const targetCount = count(state.targetCount, "target count");
  if (workspaceCount === 0) return Object.freeze({ outcome: "not_found" });
  if (workspaceCount > 1) return Object.freeze({ outcome: "ambiguous" });
  if (controlCount !== 1) return Object.freeze({ outcome: "partial_state" });
  if (request.target.kind === "invite" && memberCount !== 0) {
    return Object.freeze({ outcome: "partial_state" });
  }
  if (request.target.kind === "credential_reset" && targetCount !== 1) {
    return Object.freeze({ outcome: "not_found" });
  }
  return Object.freeze({ outcome: "collision" });
}

async function revokeUndeliveredRecovery(
  database: SqliteDatabase,
  request: OperatorRecoveryRecord,
): Promise<void> {
  const results = await batch(database, [
    sql`
      update member_invitations
      set revoked_at = max(created_at, ${request.createdAt.getTime()})
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
  const state = resultRows<DatabaseRow>(results[1])[0];
  if (!state || count(state.activeCount, "active recovery count") !== 0) {
    throw new Error("Operator identity repository could not revoke recovery.");
  }
}

export function createSqliteOperatorIdentityRepository(
  database: SqliteDatabase,
): OperatorIdentityRepository {
  return Object.freeze({
    bootstrap: (request: OperatorBootstrapRecord) => bootstrap(database, request),
    issueRecovery: (request: OperatorRecoveryRecord) =>
      issueRecovery(database, request),
    revokeUndeliveredRecovery: (request: OperatorRecoveryRecord) =>
      revokeUndeliveredRecovery(database, request),
  });
}
