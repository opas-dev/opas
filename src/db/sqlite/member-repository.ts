// ABOUTME: Persists named members, one-time credentials, and revocable sessions on SQLite and D1.
// ABOUTME: Uses transactional D1 batches and conditional writes to keep identity changes atomic.
import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";

import type {
  ActiveMemberInvitation,
  ActiveMemberSession,
  CredentialResetAcceptance,
  CredentialResetIssue,
  InvitationAcceptance,
  InvitationIdentityLookup,
  InvitationIssue,
  InvitationLookup,
  MemberCredential,
  MemberListRequest,
  MemberMutationOutcome,
  MemberRepository,
  MemberRoleChange,
  MemberSessionInput,
  MemberSessionLookup,
  MemberSessionRevocation,
  MemberStatusChange,
  TeamMemberRecord,
} from "@/auth/member-repository";
import type * as schema from "@/db/schema/sqlite";

type D1BackedDatabase = DrizzleD1Database<typeof schema> & {
  $client: AnyD1Database;
};

type SqliteDatabase =
  | D1BackedDatabase
  | BetterSQLite3Database<typeof schema>;

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

async function rows(database: SqliteDatabase, statement: SQL) {
  if (isD1Database(database)) {
    return resultRows<DatabaseRow>(await d1Statement(database, statement).all());
  }
  return database.all<DatabaseRow>(statement);
}

async function row(database: SqliteDatabase, statement: SQL) {
  if (isD1Database(database)) {
    return d1Statement(database, statement).first<DatabaseRow>();
  }
  return database.get<DatabaseRow>(statement) ?? null;
}

function date(value: unknown, field: string) {
  const milliseconds = typeof value === "number" ? value : Number(value);
  const parsed = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(parsed.getTime())) {
    throw new Error(`Member repository returned an invalid ${field}.`);
  }
  return parsed;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Member repository returned an invalid ${field}.`);
  }
  return value;
}

function nullableText(value: unknown, field: string) {
  return value === null ? null : text(value, field);
}

function nullableDate(value: unknown, field: string) {
  return value === null ? null : date(value, field);
}

function teamMember(record: DatabaseRow): TeamMemberRecord {
  return Object.freeze({
    createdAt: date(record.createdAt, "member creation time"),
    displayName: text(record.displayName, "display name"),
    email: text(record.email, "email"),
    lastLoginAt: nullableDate(record.lastLoginAt, "last login time"),
    memberId: text(record.memberId, "member ID"),
    role: role(record.role),
    status: status(record.status),
    updatedAt: date(record.updatedAt, "member update time"),
  });
}

function activeInvitation(row: DatabaseRow): ActiveMemberInvitation {
  const kind = row.kind;
  if (kind !== "invite" && kind !== "credential_reset") {
    throw new Error("Member repository returned an invalid invitation kind.");
  }
  return Object.freeze({
    createdByMemberId: nullableText(row.createdByMemberId, "invitation creator"),
    email: text(row.email, "invitation email"),
    expiresAt: date(row.expiresAt, "invitation expiry"),
    id: text(row.id, "invitation ID"),
    kind,
    memberId: nullableText(row.memberId, "invitation member ID"),
    role: row.role === null ? null : role(row.role),
    workspaceId: text(row.workspaceId, "workspace ID"),
  });
}

function role(value: unknown) {
  if (value !== "administrator" && value !== "editor" && value !== "reviewer") {
    throw new Error("Member repository returned an invalid role.");
  }
  return value;
}

function status(value: unknown) {
  if (value !== "active" && value !== "disabled") {
    throw new Error("Member repository returned an invalid status.");
  }
  return value;
}

function outcome(value: unknown): MemberMutationOutcome {
  if (
    value === "changed" ||
    value === "conflict" ||
    value === "forbidden" ||
    value === "last_administrator" ||
    value === "not_found" ||
    value === "unchanged"
  ) {
    return value;
  }
  throw new Error("Member repository returned an invalid mutation outcome.");
}

function changed(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function activeActor(actor: InvitationIssue["actor"], checkedAt: Date) {
  return sql`
    select 1
    from workspace_members actor
    inner join admin_sessions actor_session
      on actor_session.member_id = actor.id
     and actor_session.workspace_id = actor.workspace_id
    where actor.id = ${actor.memberId}
      and actor.workspace_id = ${actor.workspaceId}
      and actor.role = 'administrator'
      and actor.status = 'active'
      and actor_session.id = ${actor.sessionId}
      and actor_session.revoked_at is null
      and actor_session.expires_at > ${checkedAt.getTime()}
  `;
}

async function findCredential(
  database: SqliteDatabase,
  workspaceId: string,
  normalizedEmail: string,
): Promise<MemberCredential | null> {
  const result = await row(database, sql`
    select
      id as "memberId",
      workspace_id as "workspaceId",
      normalized_email as "email",
      display_name as "displayName",
      role,
      status,
      password_salt as "passwordSalt",
      password_digest as "passwordDigest",
      password_iterations as "passwordIterations"
    from workspace_members
    where workspace_id = ${workspaceId}
      and normalized_email = ${normalizedEmail}
    limit 1
  `);
  if (!result) return null;
  const iterations = Number(result.passwordIterations);
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("Member repository returned invalid password iterations.");
  }
  return Object.freeze({
    displayName: text(result.displayName, "display name"),
    email: text(result.email, "email"),
    memberId: text(result.memberId, "member ID"),
    password: Object.freeze({
      digest: text(result.passwordDigest, "password digest"),
      iterations,
      salt: text(result.passwordSalt, "password salt"),
    }),
    role: role(result.role),
    status: status(result.status),
    workspaceId: text(result.workspaceId, "workspace ID"),
  });
}

async function findActiveSession(
  database: SqliteDatabase,
  request: MemberSessionLookup,
): Promise<ActiveMemberSession | null> {
  const result = await row(database, sql`
    select
      sessions.id as "sessionId",
      sessions.expires_at as "expiresAt",
      members.id as "memberId",
      members.workspace_id as "workspaceId",
      members.normalized_email as "email",
      members.display_name as "displayName",
      members.role
    from admin_sessions sessions
    inner join workspace_members members
      on members.id = sessions.member_id
     and members.workspace_id = sessions.workspace_id
    where sessions.id = ${request.sessionId}
      and sessions.workspace_id = ${request.workspaceId}
      and sessions.member_id = ${request.memberId}
      and sessions.revoked_at is null
      and sessions.expires_at > ${request.checkedAt.getTime()}
      and members.status = 'active'
    limit 1
  `);
  if (!result) return null;
  return Object.freeze({
    displayName: text(result.displayName, "display name"),
    email: text(result.email, "email"),
    expiresAt: date(result.expiresAt, "session expiry"),
    memberId: text(result.memberId, "member ID"),
    role: role(result.role),
    sessionId: text(result.sessionId, "session ID"),
    workspaceId: text(result.workspaceId, "workspace ID"),
  });
}

async function listMembers(
  database: SqliteDatabase,
  request: MemberListRequest,
): Promise<readonly TeamMemberRecord[] | null> {
  const actor = activeActor(request, request.checkedAt);
  const records = await rows(database, sql`
    select
      members.id as "memberId",
      members.normalized_email as "email",
      members.display_name as "displayName",
      members.role,
      members.status,
      members.created_at as "createdAt",
      members.updated_at as "updatedAt",
      members.last_login_at as "lastLoginAt"
    from workspace_members members
    where members.workspace_id = ${request.workspaceId}
      and exists(${actor})
    order by members.normalized_email, members.id
  `);

  if (records.length === 0) return null;
  return Object.freeze(records.map(teamMember));
}

async function createSession(database: SqliteDatabase, request: MemberSessionInput) {
  const results = await batch(database, [
    sql`
      insert into admin_sessions (
        id, workspace_id, member_id, created_at, expires_at, revoked_at
      )
      select
        ${request.sessionId},
        members.workspace_id,
        members.id,
        ${request.createdAt.getTime()},
        ${request.expiresAt.getTime()},
        null
      from workspace_members members
      where members.id = ${request.memberId}
        and members.workspace_id = ${request.workspaceId}
        and members.status = 'active'
        and members.password_salt = ${request.expectedPassword.salt}
        and members.password_digest = ${request.expectedPassword.digest}
        and members.password_iterations = ${request.expectedPassword.iterations}
      on conflict (id) do nothing
      returning id
    `,
    sql`select changes() as changed`,
    sql`
      update workspace_members
      set last_login_at = ${request.createdAt.getTime()}
      where id = ${request.memberId}
        and workspace_id = ${request.workspaceId}
        and changes() = 1
      returning id
    `,
  ]);
  return changed(resultRows<DatabaseRow>(results[1])[0]?.changed);
}

async function revokeSession(database: SqliteDatabase, request: MemberSessionRevocation) {
  return (
    await rows(database, sql`
      update admin_sessions
      set revoked_at = ${request.revokedAt.getTime()}
      where id = ${request.sessionId}
        and workspace_id = ${request.workspaceId}
        and member_id = ${request.memberId}
        and revoked_at is null
      returning id
    `)
  ).length === 1;
}

async function cleanupExpiredSessions(
  database: SqliteDatabase,
  workspaceId: string,
  expiredAt: Date,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Session cleanup limits must be between 1 and 1,000.");
  }
  return (
    await rows(database, sql`
      delete from admin_sessions
      where (id, workspace_id) in (
        select id, workspace_id
        from admin_sessions
        where workspace_id = ${workspaceId}
          and expires_at <= ${expiredAt.getTime()}
        order by expires_at, id
        limit ${limit}
      )
      returning id
    `)
  ).length;
}

async function findActiveInvitation(
  database: SqliteDatabase,
  request: InvitationLookup,
): Promise<ActiveMemberInvitation | null> {
  const result = await row(database, sql`
    select
      id,
      workspace_id as "workspaceId",
      kind,
      normalized_email as "email",
      target_role as "role",
      member_id as "memberId",
      created_by_member_id as "createdByMemberId",
      expires_at as "expiresAt"
    from member_invitations
    where token_digest = ${request.tokenDigest}
      and kind = ${request.kind}
      and accepted_at is null
      and revoked_at is null
      and expires_at > ${request.checkedAt.getTime()}
    limit 1
  `);
  if (!result) return null;
  return activeInvitation(result);
}

async function findActiveInvitationByIdentity(
  database: SqliteDatabase,
  request: InvitationIdentityLookup,
): Promise<ActiveMemberInvitation | null> {
  const result = await row(database, sql`
    select
      id,
      workspace_id as "workspaceId",
      kind,
      normalized_email as "email",
      target_role as "role",
      member_id as "memberId",
      created_by_member_id as "createdByMemberId",
      expires_at as "expiresAt"
    from member_invitations
    where id = ${request.id}
      and workspace_id = ${request.workspaceId}
      and kind = ${request.kind}
      and accepted_at is null
      and revoked_at is null
      and expires_at > ${request.checkedAt.getTime()}
    limit 1
  `);
  if (!result) return null;
  return activeInvitation(result);
}

async function replaceInvitation(database: SqliteDatabase, request: InvitationIssue) {
  const actor = activeActor(request.actor, request.createdAt);
  const results = await batch(database, [
    sql`
      update member_invitations
      set revoked_at = ${request.createdAt.getTime()}
      where workspace_id = ${request.actor.workspaceId}
        and kind = 'invite'
        and normalized_email = ${request.email}
        and accepted_at is null
        and revoked_at is null
        and exists(${actor})
        and not exists (
          select 1 from workspace_members
          where workspace_id = ${request.actor.workspaceId}
            and normalized_email = ${request.email}
        )
      returning id
    `,
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
        ${request.id},
        ${request.actor.workspaceId},
        'invite',
        ${request.email},
        ${request.role},
        null,
        ${request.tokenDigest},
        ${request.actor.memberId},
        ${request.createdAt.getTime()},
        ${request.expiresAt.getTime()},
        null,
        null
      where exists(${actor})
        and not exists (
          select 1 from workspace_members
          where workspace_id = ${request.actor.workspaceId}
            and normalized_email = ${request.email}
        )
      returning id
    `,
    sql`
      select case
        when changes() = 1 then 'changed'
        when not exists(${actor}) then 'forbidden'
        else 'conflict'
      end as outcome
    `,
  ]);
  return outcome(resultRows<DatabaseRow>(results[2])[0]?.outcome);
}

async function replaceCredentialReset(
  database: SqliteDatabase,
  request: CredentialResetIssue,
) {
  const actor = activeActor(request.actor, request.createdAt);
  const results = await batch(database, [
    sql`
      update member_invitations
      set revoked_at = ${request.createdAt.getTime()}
      where workspace_id = ${request.actor.workspaceId}
        and kind = 'credential_reset'
        and member_id = ${request.memberId}
        and accepted_at is null
        and revoked_at is null
        and ${request.memberId} <> ${request.actor.memberId}
        and exists(${actor})
        and exists (
          select 1 from workspace_members
          where id = ${request.memberId}
            and workspace_id = ${request.actor.workspaceId}
        )
      returning id
    `,
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
        ${request.id},
        members.workspace_id,
        'credential_reset',
        members.normalized_email,
        null,
        members.id,
        ${request.tokenDigest},
        ${request.actor.memberId},
        ${request.createdAt.getTime()},
        ${request.expiresAt.getTime()},
        null,
        null
      from workspace_members members
      where members.id = ${request.memberId}
        and members.workspace_id = ${request.actor.workspaceId}
        and ${request.memberId} <> ${request.actor.memberId}
        and exists(${actor})
      returning id
    `,
    sql`
      select case
        when changes() = 1 then 'changed'
        when not exists(${actor}) then 'forbidden'
        when not exists (
          select 1 from workspace_members
          where id = ${request.memberId}
            and workspace_id = ${request.actor.workspaceId}
        ) then 'not_found'
        else 'forbidden'
      end as outcome
    `,
    sql`
      update admin_sessions
      set revoked_at = ${request.createdAt.getTime()}
      where workspace_id = ${request.actor.workspaceId}
        and member_id = ${request.memberId}
        and revoked_at is null
        and changes() = 1
      returning id
    `,
  ]);
  return outcome(resultRows<DatabaseRow>(results[2])[0]?.outcome);
}

async function acceptInvitation(
  database: SqliteDatabase,
  request: InvitationAcceptance,
) {
  const results = await batch(database, [
    sql`
      update member_invitations as invitation
      set accepted_at = ${request.acceptedAt.getTime()}
      where invitation.id = ${request.invitationId}
        and invitation.workspace_id = ${request.workspaceId}
        and invitation.kind = 'invite'
        and invitation.accepted_at is null
        and invitation.revoked_at is null
        and invitation.expires_at > ${request.acceptedAt.getTime()}
        and not exists (
          select 1 from workspace_members existing
          where existing.workspace_id = invitation.workspace_id
            and existing.normalized_email = invitation.normalized_email
        )
        and (
          invitation.created_by_member_id is not null
          or (
            invitation.target_role = 'administrator'
            and not exists (
              select 1 from workspace_members existing
              where existing.workspace_id = invitation.workspace_id
            )
          )
        )
      returning id
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
        invitation.workspace_id,
        invitation.normalized_email,
        ${request.displayName},
        invitation.target_role,
        'active',
        ${request.password.salt},
        ${request.password.digest},
        ${request.password.iterations},
        invitation.created_by_member_id,
        ${request.acceptedAt.getTime()},
        ${request.acceptedAt.getTime()},
        null
      from member_invitations invitation
      where invitation.id = ${request.invitationId}
        and invitation.workspace_id = ${request.workspaceId}
        and invitation.accepted_at = ${request.acceptedAt.getTime()}
        and changes() = 1
      returning id
    `,
    sql`select changes() as changed`,
  ]);
  return changed(resultRows<DatabaseRow>(results[2])[0]?.changed);
}

async function acceptCredentialReset(
  database: SqliteDatabase,
  request: CredentialResetAcceptance,
) {
  const results = await batch(database, [
    sql`
      update member_invitations
      set accepted_at = ${request.acceptedAt.getTime()}
      where id = ${request.invitationId}
        and workspace_id = ${request.workspaceId}
        and kind = 'credential_reset'
        and accepted_at is null
        and revoked_at is null
        and expires_at > ${request.acceptedAt.getTime()}
      returning member_id
    `,
    sql`
      update workspace_members
      set
        password_salt = ${request.password.salt},
        password_digest = ${request.password.digest},
        password_iterations = ${request.password.iterations},
        updated_at = ${request.acceptedAt.getTime()}
      where workspace_id = ${request.workspaceId}
        and id = (
          select member_id from member_invitations
          where id = ${request.invitationId}
            and workspace_id = ${request.workspaceId}
        )
        and changes() = 1
      returning id
    `,
    sql`select changes() as changed`,
    sql`
      update admin_sessions
      set revoked_at = ${request.acceptedAt.getTime()}
      where workspace_id = ${request.workspaceId}
        and member_id = (
          select member_id from member_invitations
          where id = ${request.invitationId}
            and workspace_id = ${request.workspaceId}
        )
        and revoked_at is null
        and changes() = 1
      returning id
    `,
  ]);
  return changed(resultRows<DatabaseRow>(results[2])[0]?.changed);
}

function memberChangeStatements(
  request: MemberRoleChange | MemberStatusChange,
  field: "role" | "status",
) {
  const nextValue =
    field === "role"
      ? (request as MemberRoleChange).role
      : (request as MemberStatusChange).status;
  const actor = activeActor(request.actor, request.changedAt);
  const valueDiffers =
    field === "role"
      ? sql`target.role <> ${nextValue}`
      : sql`target.status <> ${nextValue}`;
  const storedValueDiffers =
    field === "role"
      ? sql`role <> ${nextValue}`
      : sql`status <> ${nextValue}`;
  const removesActiveAdministrator =
    field === "role"
      ? sql`target.status = 'active' and target.role = 'administrator' and ${nextValue} <> 'administrator'`
      : sql`target.status = 'active' and target.role = 'administrator' and ${nextValue} <> 'active'`;
  const storedRemovesActiveAdministrator =
    field === "role"
      ? sql`status = 'active' and role = 'administrator' and ${nextValue} <> 'administrator'`
      : sql`status = 'active' and role = 'administrator' and ${nextValue} <> 'active'`;
  const assignment =
    field === "role"
      ? sql`role = ${nextValue}, updated_at = ${request.changedAt.getTime()}`
      : sql`status = ${nextValue}, updated_at = ${request.changedAt.getTime()}`;
  const eligibleTarget = sql`
    target.id = ${request.memberId}
    and target.workspace_id = ${request.actor.workspaceId}
    and target.id <> ${request.actor.memberId}
    and exists(${actor})
    and ${valueDiffers}
    and not (
      ${removesActiveAdministrator}
      and not exists (
        select 1
        from workspace_members other
        where other.workspace_id = target.workspace_id
          and other.id <> target.id
          and other.role = 'administrator'
          and other.status = 'active'
      )
    )
  `;
  const statements: SQL[] = [
    sql`
      update admin_sessions
      set revoked_at = ${request.changedAt.getTime()}
      where workspace_id = ${request.actor.workspaceId}
        and member_id = ${request.memberId}
        and revoked_at is null
        and exists (
          select 1 from workspace_members target
          where ${eligibleTarget}
        )
      returning id
    `,
  ];
  if (field === "status" && nextValue === "disabled") {
    statements.push(sql`
      update article_preview_grants
      set
        revoked_at = ${request.changedAt.getTime()},
        revoked_by_member_id = ${request.actor.memberId}
      where workspace_id = ${request.actor.workspaceId}
        and created_by_member_id = ${request.memberId}
        and revoked_at is null
        and exists (
          select 1 from workspace_members target
          where ${eligibleTarget}
        )
      returning id
    `);
  }
  statements.push(
    sql`
      update workspace_members as target
      set ${assignment}
      where ${eligibleTarget}
      returning id
    `,
    sql`
      select case
        when changes() = 1 then 'changed'
        when not exists(${actor}) then 'forbidden'
        when not exists (
          select 1 from workspace_members
          where id = ${request.memberId}
            and workspace_id = ${request.actor.workspaceId}
        ) then 'not_found'
        when ${request.memberId} = ${request.actor.memberId} then 'forbidden'
        when exists (
          select 1 from workspace_members
          where id = ${request.memberId}
            and workspace_id = ${request.actor.workspaceId}
            and not (${storedValueDiffers})
        ) then 'unchanged'
        when exists (
          select 1 from workspace_members target
          where target.id = ${request.memberId}
            and target.workspace_id = ${request.actor.workspaceId}
            and ${storedRemovesActiveAdministrator}
            and not exists (
              select 1 from workspace_members other
              where other.workspace_id = target.workspace_id
                and other.id <> target.id
                and other.role = 'administrator'
                and other.status = 'active'
            )
        ) then 'last_administrator'
        else 'conflict'
      end as outcome
    `,
  );
  return statements;
}

async function changeMember(
  database: SqliteDatabase,
  request: MemberRoleChange | MemberStatusChange,
  field: "role" | "status",
) {
  const statements = memberChangeStatements(request, field);
  const results = await batch(database, statements);
  return outcome(
    resultRows<DatabaseRow>(results[statements.length - 1])[0]?.outcome,
  );
}

export function createSqliteMemberRepository(database: SqliteDatabase): MemberRepository {
  const repository: MemberRepository = {
    acceptCredentialReset: (request) => acceptCredentialReset(database, request),
    acceptInvitation: (request) => acceptInvitation(database, request),
    changeMemberRole: (request) => changeMember(database, request, "role"),
    changeMemberStatus: (request) => changeMember(database, request, "status"),
    cleanupExpiredSessions: (workspaceId, expiredAt, limit) =>
      cleanupExpiredSessions(database, workspaceId, expiredAt, limit),
    createSession: (request) => createSession(database, request),
    findActiveInvitation: (request) => findActiveInvitation(database, request),
    findActiveInvitationByIdentity: (request) =>
      findActiveInvitationByIdentity(database, request),
    findActiveSession: (request) => findActiveSession(database, request),
    findCredential: (workspaceId, normalizedEmail) =>
      findCredential(database, workspaceId, normalizedEmail),
    listMembers: (request) => listMembers(database, request),
    replaceCredentialReset: (request) => replaceCredentialReset(database, request),
    replaceInvitation: (request) => replaceInvitation(database, request),
    revokeSession: (request) => revokeSession(database, request),
  };
  return Object.freeze(repository);
}
