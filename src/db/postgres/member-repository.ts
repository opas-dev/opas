// ABOUTME: Persists named members, one-time credentials, and revocable sessions on Postgres and Neon.
// ABOUTME: Serializes workspace identity changes and rechecks the acting administrator in each transaction.
import { sql, type SQL } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

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
  if (statements.length === 0) return [];
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

function teamMember(row: DatabaseRow): TeamMemberRecord {
  return Object.freeze({
    createdAt: date(row.createdAt, "member creation time"),
    displayName: text(row.displayName, "display name"),
    email: text(row.email, "email"),
    lastLoginAt: nullableDate(row.lastLoginAt, "last login time"),
    memberId: text(row.memberId, "member ID"),
    role: role(row.role),
    status: status(row.status),
    updatedAt: date(row.updatedAt, "member update time"),
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

function numericCount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Member repository returned an invalid row count.");
  }
  return parsed;
}

function lockWorkspace(workspaceId: string) {
  return sql`select id from workspaces where id = ${workspaceId} for update`;
}

function activeActor(
  actor: InvitationIssue["actor"],
  checkedAt: Date,
) {
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
      and actor_session.expires_at > ${checkedAt}
  `;
}

async function findCredential(
  database: PostgresDatabase,
  workspaceId: string,
  normalizedEmail: string,
): Promise<MemberCredential | null> {
  const rows = resultRows<DatabaseRow>(
    await database.execute(sql`
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
    `),
  );
  const row = rows[0];
  if (!row) return null;
  const iterations = numericCount(row.passwordIterations);
  return Object.freeze({
    displayName: text(row.displayName, "display name"),
    email: text(row.email, "email"),
    memberId: text(row.memberId, "member ID"),
    password: Object.freeze({
      digest: text(row.passwordDigest, "password digest"),
      iterations,
      salt: text(row.passwordSalt, "password salt"),
    }),
    role: role(row.role),
    status: status(row.status),
    workspaceId: text(row.workspaceId, "workspace ID"),
  });
}

async function findActiveSession(
  database: PostgresDatabase,
  request: MemberSessionLookup,
): Promise<ActiveMemberSession | null> {
  const rows = resultRows<DatabaseRow>(
    await database.execute(sql`
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
        and sessions.expires_at > ${request.checkedAt}
        and members.status = 'active'
      limit 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return Object.freeze({
    displayName: text(row.displayName, "display name"),
    email: text(row.email, "email"),
    expiresAt: date(row.expiresAt, "session expiry"),
    memberId: text(row.memberId, "member ID"),
    role: role(row.role),
    sessionId: text(row.sessionId, "session ID"),
    workspaceId: text(row.workspaceId, "workspace ID"),
  });
}

async function listMembers(
  database: PostgresDatabase,
  request: MemberListRequest,
): Promise<readonly TeamMemberRecord[] | null> {
  const authorized = activeActor(request, request.checkedAt);
  const records = resultRows<DatabaseRow>(
    await database.execute(sql`
      with authorized as materialized (${authorized})
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
        and exists(select 1 from authorized)
      order by members.normalized_email, members.id
    `),
  );

  if (records.length === 0) return null;
  return Object.freeze(records.map(teamMember));
}

async function createSession(database: PostgresDatabase, request: MemberSessionInput) {
  const results = await transaction(database, [
    lockWorkspace(request.workspaceId),
    sql`
      with created as (
        insert into admin_sessions (
          id, workspace_id, member_id, created_at, expires_at, revoked_at
        )
        select
          ${request.sessionId},
          members.workspace_id,
          members.id,
          ${request.createdAt},
          ${request.expiresAt},
          null
        from workspace_members members
        where members.id = ${request.memberId}
          and members.workspace_id = ${request.workspaceId}
          and members.status = 'active'
          and members.password_salt = ${request.expectedPassword.salt}
          and members.password_digest = ${request.expectedPassword.digest}
          and members.password_iterations = ${request.expectedPassword.iterations}
        on conflict (id) do nothing
        returning member_id, workspace_id
      ), touched as (
        update workspace_members members
        set last_login_at = ${request.createdAt}
        from created
        where members.id = created.member_id
          and members.workspace_id = created.workspace_id
        returning members.id
      )
      select exists(select 1 from created) as changed
    `,
  ]);
  return changed(resultRows<DatabaseRow>(results[1])[0]?.changed);
}

async function revokeSession(
  database: PostgresDatabase,
  request: MemberSessionRevocation,
) {
  const rows = resultRows<DatabaseRow>(
    await database.execute(sql`
      update admin_sessions
      set revoked_at = ${request.revokedAt}
      where id = ${request.sessionId}
        and workspace_id = ${request.workspaceId}
        and member_id = ${request.memberId}
        and revoked_at is null
      returning id
    `),
  );
  return rows.length === 1;
}

async function cleanupExpiredSessions(
  database: PostgresDatabase,
  workspaceId: string,
  expiredAt: Date,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Session cleanup limits must be between 1 and 1,000.");
  }
  return resultRows<DatabaseRow>(
    await database.execute(sql`
      delete from admin_sessions
      where (id, workspace_id) in (
        select id, workspace_id
        from admin_sessions
        where workspace_id = ${workspaceId}
          and expires_at <= ${expiredAt}
        order by expires_at, id
        limit ${limit}
      )
      returning id
    `),
  ).length;
}

async function findActiveInvitation(
  database: PostgresDatabase,
  request: InvitationLookup,
): Promise<ActiveMemberInvitation | null> {
  const rows = resultRows<DatabaseRow>(
    await database.execute(sql`
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
        and expires_at > ${request.checkedAt}
      limit 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return activeInvitation(row);
}

async function findActiveInvitationByIdentity(
  database: PostgresDatabase,
  request: InvitationIdentityLookup,
): Promise<ActiveMemberInvitation | null> {
  const rows = resultRows<DatabaseRow>(
    await database.execute(sql`
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
        and expires_at > ${request.checkedAt}
      limit 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return activeInvitation(row);
}

async function replaceInvitation(database: PostgresDatabase, request: InvitationIssue) {
  const actor = activeActor(request.actor, request.createdAt);
  const results = await transaction(database, [
    lockWorkspace(request.actor.workspaceId),
    sql`
      with authorized as materialized (${actor}),
      available as materialized (
        select 1
        where not exists (
          select 1
          from workspace_members
          where workspace_id = ${request.actor.workspaceId}
            and normalized_email = ${request.email}
        )
      ), revoked as (
        update member_invitations
        set revoked_at = ${request.createdAt}
        where workspace_id = ${request.actor.workspaceId}
          and kind = 'invite'
          and normalized_email = ${request.email}
          and accepted_at is null
          and revoked_at is null
          and exists(select 1 from authorized)
          and exists(select 1 from available)
        returning id
      ), created as (
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
          ${request.createdAt},
          ${request.expiresAt},
          null,
          null
        where exists(select 1 from authorized)
          and exists(select 1 from available)
          and (select count(*) from revoked) >= 0
        returning id
      )
      select case
        when exists(select 1 from created) then 'changed'
        when not exists(select 1 from authorized) then 'forbidden'
        else 'conflict'
      end as outcome
    `,
  ]);
  return outcome(resultRows<DatabaseRow>(results[1])[0]?.outcome);
}

async function replaceCredentialReset(
  database: PostgresDatabase,
  request: CredentialResetIssue,
) {
  const actor = activeActor(request.actor, request.createdAt);
  const results = await transaction(database, [
    lockWorkspace(request.actor.workspaceId),
    sql`
      with authorized as materialized (${actor}),
      target as materialized (
        select id, workspace_id, normalized_email
        from workspace_members
        where id = ${request.memberId}
          and workspace_id = ${request.actor.workspaceId}
      ), revoked as (
        update member_invitations
        set revoked_at = ${request.createdAt}
        where workspace_id = ${request.actor.workspaceId}
          and kind = 'credential_reset'
          and member_id = ${request.memberId}
          and accepted_at is null
          and revoked_at is null
          and exists(select 1 from authorized)
          and exists(select 1 from target)
          and ${request.memberId} <> ${request.actor.memberId}
        returning id
      ), created as (
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
          target.workspace_id,
          'credential_reset',
          target.normalized_email,
          null,
          target.id,
          ${request.tokenDigest},
          ${request.actor.memberId},
          ${request.createdAt},
          ${request.expiresAt},
          null,
          null
        from target
        where exists(select 1 from authorized)
          and ${request.memberId} <> ${request.actor.memberId}
          and (select count(*) from revoked) >= 0
        returning member_id, workspace_id
      ), revoked_sessions as (
        update admin_sessions sessions
        set revoked_at = ${request.createdAt}
        from created
        where sessions.member_id = created.member_id
          and sessions.workspace_id = created.workspace_id
          and sessions.revoked_at is null
        returning sessions.id
      )
      select case
        when exists(select 1 from created) then 'changed'
        when not exists(select 1 from authorized) then 'forbidden'
        when not exists(select 1 from target) then 'not_found'
        else 'forbidden'
      end as outcome
    `,
  ]);
  return outcome(resultRows<DatabaseRow>(results[1])[0]?.outcome);
}

async function acceptInvitation(
  database: PostgresDatabase,
  request: InvitationAcceptance,
) {
  const results = await transaction(database, [
    lockWorkspace(request.workspaceId),
    sql`
      with candidate as materialized (
        select invitations.*
        from member_invitations invitations
        where invitations.id = ${request.invitationId}
          and invitations.workspace_id = ${request.workspaceId}
          and invitations.kind = 'invite'
          and invitations.accepted_at is null
          and invitations.revoked_at is null
          and invitations.expires_at > ${request.acceptedAt}
          and not exists (
            select 1
            from workspace_members existing
            where existing.workspace_id = invitations.workspace_id
              and existing.normalized_email = invitations.normalized_email
          )
          and (
            invitations.created_by_member_id is not null
            or (
              invitations.target_role = 'administrator'
              and not exists (
                select 1 from workspace_members existing
                where existing.workspace_id = invitations.workspace_id
              )
            )
          )
      ), consumed as (
        update member_invitations invitations
        set accepted_at = ${request.acceptedAt}
        from candidate
        where invitations.id = candidate.id
          and invitations.workspace_id = candidate.workspace_id
        returning
          invitations.workspace_id,
          invitations.normalized_email,
          invitations.target_role,
          invitations.created_by_member_id
      ), created as (
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
          consumed.workspace_id,
          consumed.normalized_email,
          ${request.displayName},
          consumed.target_role,
          'active',
          ${request.password.salt},
          ${request.password.digest},
          ${request.password.iterations},
          consumed.created_by_member_id,
          ${request.acceptedAt},
          ${request.acceptedAt},
          null
        from consumed
        returning id
      )
      select exists(select 1 from created) as changed
    `,
  ]);
  return changed(resultRows<DatabaseRow>(results[1])[0]?.changed);
}

async function acceptCredentialReset(
  database: PostgresDatabase,
  request: CredentialResetAcceptance,
) {
  const results = await transaction(database, [
    lockWorkspace(request.workspaceId),
    sql`
      with consumed as (
        update member_invitations invitations
        set accepted_at = ${request.acceptedAt}
        where invitations.id = ${request.invitationId}
          and invitations.workspace_id = ${request.workspaceId}
          and invitations.kind = 'credential_reset'
          and invitations.accepted_at is null
          and invitations.revoked_at is null
          and invitations.expires_at > ${request.acceptedAt}
        returning invitations.member_id, invitations.workspace_id
      ), changed_member as (
        update workspace_members members
        set
          password_salt = ${request.password.salt},
          password_digest = ${request.password.digest},
          password_iterations = ${request.password.iterations},
          updated_at = ${request.acceptedAt}
        from consumed
        where members.id = consumed.member_id
          and members.workspace_id = consumed.workspace_id
        returning members.id, members.workspace_id
      ), revoked_sessions as (
        update admin_sessions sessions
        set revoked_at = ${request.acceptedAt}
        from changed_member
        where sessions.member_id = changed_member.id
          and sessions.workspace_id = changed_member.workspace_id
          and sessions.revoked_at is null
        returning sessions.id
      )
      select exists(select 1 from changed_member) as changed
    `,
  ]);
  return changed(resultRows<DatabaseRow>(results[1])[0]?.changed);
}

function memberChangeOutcomeStatement(
  request: MemberRoleChange | MemberStatusChange,
  field: "role" | "status",
) {
  const nextValue = field === "role" ? (request as MemberRoleChange).role : (request as MemberStatusChange).status;
  const actor = activeActor(request.actor, request.changedAt);
  const valueDiffers =
    field === "role"
      ? sql`target.role <> ${nextValue}`
      : sql`target.status <> ${nextValue}`;
  const removesActiveAdministrator =
    field === "role"
      ? sql`target.status = 'active' and target.role = 'administrator' and ${nextValue} <> 'administrator'`
      : sql`target.status = 'active' and target.role = 'administrator' and ${nextValue} <> 'active'`;
  const assignment =
    field === "role"
      ? sql`role = ${nextValue}, updated_at = ${request.changedAt}`
      : sql`status = ${nextValue}, updated_at = ${request.changedAt}`;
  const previewRevocation =
    field === "status" && nextValue === "disabled"
      ? sql`, revoked_previews as (
          update article_preview_grants grants
          set
            revoked_at = ${request.changedAt},
            revoked_by_member_id = ${request.actor.memberId}
          from changed_member
          where grants.workspace_id = changed_member.workspace_id
            and grants.created_by_member_id = changed_member.id
            and grants.revoked_at is null
          returning grants.id
        )`
      : sql``;

  return sql`
    with authorized as materialized (${actor}),
    target as materialized (
      select id, workspace_id, role, status
      from workspace_members
      where id = ${request.memberId}
        and workspace_id = ${request.actor.workspaceId}
    ), changed_member as (
      update workspace_members members
      set ${assignment}
      from target
      where members.id = target.id
        and members.workspace_id = target.workspace_id
        and exists(select 1 from authorized)
        and target.id <> ${request.actor.memberId}
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
      returning members.id, members.workspace_id
    ), revoked_sessions as (
      update admin_sessions sessions
      set revoked_at = ${request.changedAt}
      from changed_member
      where sessions.member_id = changed_member.id
        and sessions.workspace_id = changed_member.workspace_id
        and sessions.revoked_at is null
      returning sessions.id
    )${previewRevocation}
    select case
      when exists(select 1 from changed_member) then 'changed'
      when not exists(select 1 from authorized) then 'forbidden'
      when not exists(select 1 from target) then 'not_found'
      when exists(select 1 from target where id = ${request.actor.memberId}) then 'forbidden'
      when exists(select 1 from target where not (${valueDiffers})) then 'unchanged'
      when exists(
        select 1 from target
        where ${removesActiveAdministrator}
          and not exists (
            select 1
            from workspace_members other
            where other.workspace_id = target.workspace_id
              and other.id <> target.id
              and other.role = 'administrator'
              and other.status = 'active'
          )
      ) then 'last_administrator'
      else 'conflict'
    end as outcome
  `;
}

async function changeMember(
  database: PostgresDatabase,
  request: MemberRoleChange | MemberStatusChange,
  field: "role" | "status",
) {
  const results = await transaction(database, [
    lockWorkspace(request.actor.workspaceId),
    memberChangeOutcomeStatement(request, field),
  ]);
  return outcome(resultRows<DatabaseRow>(results[1])[0]?.outcome);
}

export function createPostgresMemberRepository(
  database: PostgresDatabase,
): MemberRepository {
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
