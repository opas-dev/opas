// ABOUTME: Runs the named-member persistence contract against Postgres, SQLite, and D1 semantics.
// ABOUTME: Verifies revocation, one-time credentials, administrator races, and deletion boundaries.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createD1Database } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import type {
  MemberPassword,
  MemberRepository,
} from "@/auth/member-repository";
import { createPostgresMemberRepository } from "@/db/postgres/member-repository";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteMemberRepository } from "@/db/sqlite/member-repository";

const startedAt = new Date("2026-09-03T10:00:00.000Z");
const hour = 60 * 60 * 1_000;
const day = 24 * hour;

function password(character: string): MemberPassword {
  return Object.freeze({
    digest: character.repeat(43),
    iterations: 600_000,
    salt: character.toUpperCase().repeat(43),
  });
}

function sessionId(character: string) {
  return character.repeat(43);
}

function grantId(character: string) {
  return character.repeat(43);
}

type MemberSeed = Readonly<{
  createdByMemberId: string | null;
  displayName: string;
  email: string;
  id: string;
  role: "administrator" | "editor" | "reviewer";
  status?: "active" | "disabled";
  workspaceId: string;
}>;

type PreviewState = Readonly<{
  revokedAt: Date | null;
  revokedByMemberId: string | null;
}>;

type Harness = Readonly<{
  activeAdministratorCount(workspaceId: string): Promise<number>;
  childCount(workspaceId: string): Promise<number>;
  close(): Promise<void>;
  createMember(member: MemberSeed): Promise<void>;
  createPreview(workspaceId: string, memberId: string, id: string): Promise<void>;
  createWorkspace(id: string): Promise<void>;
  deleteMember(memberId: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  invitationState(id: string): Promise<Readonly<{ accepted: boolean; revoked: boolean }> | null>;
  previewState(id: string): Promise<PreviewState | null>;
  repository: MemberRepository;
  sessionCount(workspaceId: string): Promise<number>;
}>;

function actor(workspaceId: string, memberId: string, id: string) {
  return Object.freeze({ memberId, sessionId: id, workspaceId });
}

async function exerciseMemberRepository(name: string, harness: Harness) {
  const workspaceId = `workspace_${name}`;
  const adminId = `admin_${name}`;
  const secondAdminId = `admin_two_${name}`;
  const editorId = `editor_${name}`;
  const reviewerId = `reviewer_${name}`;
  const adminSessionId = sessionId("A");

  await harness.createWorkspace(workspaceId);
  await harness.createMember({
    createdByMemberId: null,
    displayName: "Ada Admin",
    email: `admin-${name}@example.com`,
    id: adminId,
    role: "administrator",
    workspaceId,
  });
  await harness.createMember({
    createdByMemberId: adminId,
    displayName: "Ed Editor",
    email: `editor-${name}@example.com`,
    id: editorId,
    role: "editor",
    workspaceId,
  });
  await harness.createMember({
    createdByMemberId: adminId,
    displayName: "Rae Reviewer",
    email: `reviewer-${name}@example.com`,
    id: reviewerId,
    role: "reviewer",
    workspaceId,
  });

  assert.deepEqual(
    await harness.repository.findCredential(workspaceId, `editor-${name}@example.com`),
    {
      displayName: "Ed Editor",
      email: `editor-${name}@example.com`,
      memberId: editorId,
      password: password("a"),
      role: "editor",
      status: "active",
      workspaceId,
    },
  );
  assert.equal(
    await harness.repository.findCredential(workspaceId, `missing-${name}@example.com`),
    null,
  );

  assert.equal(
    await harness.repository.createSession({
      ...actor(workspaceId, adminId, adminSessionId),
      createdAt: startedAt,
      expiresAt: new Date(startedAt.getTime() + 8 * hour),
      expectedPassword: password("a"),
    }),
    true,
  );
  assert.deepEqual(
    await harness.repository.findActiveSession({
      ...actor(workspaceId, adminId, adminSessionId),
      checkedAt: new Date(startedAt.getTime() + hour),
    }),
    {
      displayName: "Ada Admin",
      email: `admin-${name}@example.com`,
      expiresAt: new Date(startedAt.getTime() + 8 * hour),
      memberId: adminId,
      role: "administrator",
      sessionId: adminSessionId,
      workspaceId,
    },
  );
  assert.equal(
    await harness.repository.findActiveSession({
      checkedAt: new Date(startedAt.getTime() + hour),
      memberId: editorId,
      sessionId: adminSessionId,
      workspaceId,
    }),
    null,
  );
  const listedMembers = await harness.repository.listMembers({
    ...actor(workspaceId, adminId, adminSessionId),
    checkedAt: new Date(startedAt.getTime() + hour),
  });
  assert.deepEqual(listedMembers, [
    {
      createdAt: startedAt,
      displayName: "Ada Admin",
      email: `admin-${name}@example.com`,
      lastLoginAt: startedAt,
      memberId: adminId,
      role: "administrator",
      status: "active",
      updatedAt: startedAt,
    },
    {
      createdAt: startedAt,
      displayName: "Ed Editor",
      email: `editor-${name}@example.com`,
      lastLoginAt: null,
      memberId: editorId,
      role: "editor",
      status: "active",
      updatedAt: startedAt,
    },
    {
      createdAt: startedAt,
      displayName: "Rae Reviewer",
      email: `reviewer-${name}@example.com`,
      lastLoginAt: null,
      memberId: reviewerId,
      role: "reviewer",
      status: "active",
      updatedAt: startedAt,
    },
  ]);
  assert.equal(JSON.stringify(listedMembers).includes("password"), false);
  assert.equal(
    await harness.repository.listMembers({
      checkedAt: new Date(startedAt.getTime() + hour),
      memberId: adminId,
      sessionId: adminSessionId,
      workspaceId: "workspace_wrong",
    }),
    null,
  );

  const expiredOne = sessionId("B");
  const expiredTwo = sessionId("C");
  for (const [id, offset] of [
    [expiredOne, -3 * hour],
    [expiredTwo, -2 * hour],
  ] as const) {
    assert.equal(
      await harness.repository.createSession({
        createdAt: new Date(startedAt.getTime() - 10 * hour),
        expiresAt: new Date(startedAt.getTime() + offset),
        expectedPassword: password("a"),
        memberId: editorId,
        sessionId: id,
        workspaceId,
      }),
      true,
    );
  }
  assert.equal(
    await harness.repository.cleanupExpiredSessions(workspaceId, startedAt, 1),
    1,
  );
  assert.equal(await harness.sessionCount(workspaceId), 2);
  const logoutSessionId = sessionId("L");
  assert.equal(
    await harness.repository.createSession({
      createdAt: startedAt,
      expiresAt: new Date(startedAt.getTime() + 8 * hour),
      expectedPassword: password("a"),
      memberId: editorId,
      sessionId: logoutSessionId,
      workspaceId,
    }),
    true,
  );
  assert.equal(
    await harness.repository.revokeSession({
      memberId: reviewerId,
      revokedAt: new Date(startedAt.getTime() + hour),
      sessionId: logoutSessionId,
      workspaceId,
    }),
    false,
  );
  assert.equal(
    await harness.repository.revokeSession({
      memberId: editorId,
      revokedAt: new Date(startedAt.getTime() + hour),
      sessionId: logoutSessionId,
      workspaceId,
    }),
    true,
  );
  assert.equal(
    await harness.repository.revokeSession({
      memberId: editorId,
      revokedAt: new Date(startedAt.getTime() + hour + 1),
      sessionId: logoutSessionId,
      workspaceId,
    }),
    false,
  );

  const firstInviteId = `invite_one_${name}`;
  const secondInviteId = `invite_two_${name}`;
  const invitedEmail = `invited-${name}@example.com`;
  const adminActor = actor(workspaceId, adminId, adminSessionId);
  assert.equal(
    await harness.repository.changeMemberRole({
      actor: adminActor,
      changedAt: new Date(startedAt.getTime() + hour - 2),
      memberId: adminId,
      role: "reviewer",
    }),
    "forbidden",
  );
  assert.equal(
    await harness.repository.changeMemberStatus({
      actor: adminActor,
      changedAt: new Date(startedAt.getTime() + hour - 1),
      memberId: adminId,
      status: "disabled",
    }),
    "forbidden",
  );
  assert.equal(
    await harness.repository.replaceCredentialReset({
      actor: adminActor,
      createdAt: new Date(startedAt.getTime() + hour - 1),
      expiresAt: new Date(startedAt.getTime() + 2 * hour - 1),
      id: `reset_self_${name}`,
      memberId: adminId,
      tokenDigest: "0".repeat(64),
    }),
    "forbidden",
  );
  assert.equal(
    await harness.repository.replaceInvitation({
      actor: adminActor,
      createdAt: new Date(startedAt.getTime() + hour),
      email: invitedEmail,
      expiresAt: new Date(startedAt.getTime() + hour + 2 * day),
      id: firstInviteId,
      role: "editor",
      tokenDigest: "1".repeat(64),
    }),
    "changed",
  );
  assert.equal(
    await harness.repository.replaceInvitation({
      actor: adminActor,
      createdAt: new Date(startedAt.getTime() + hour + 1_000),
      email: invitedEmail,
      expiresAt: new Date(startedAt.getTime() + hour + 1_000 + 2 * day),
      id: secondInviteId,
      role: "reviewer",
      tokenDigest: "2".repeat(64),
    }),
    "changed",
  );
  assert.deepEqual(await harness.invitationState(firstInviteId), {
    accepted: false,
    revoked: true,
  });
  assert.equal(
    await harness.repository.findActiveInvitation({
      checkedAt: new Date(startedAt.getTime() + 2 * hour),
      kind: "invite",
      tokenDigest: "1".repeat(64),
    }),
    null,
  );
  assert.deepEqual(
    await harness.repository.findActiveInvitation({
      checkedAt: new Date(startedAt.getTime() + 2 * hour),
      kind: "invite",
      tokenDigest: "2".repeat(64),
    }),
    {
      createdByMemberId: adminId,
      email: invitedEmail,
      expiresAt: new Date(startedAt.getTime() + hour + 1_000 + 2 * day),
      id: secondInviteId,
      kind: "invite",
      memberId: null,
      role: "reviewer",
      workspaceId,
    },
  );
  assert.equal(
    await harness.repository.findActiveInvitationByIdentity({
      checkedAt: new Date(startedAt.getTime() + 2 * hour),
      id: secondInviteId,
      kind: "credential_reset",
      workspaceId,
    }),
    null,
  );
  assert.deepEqual(
    await harness.repository.findActiveInvitationByIdentity({
      checkedAt: new Date(startedAt.getTime() + 2 * hour),
      id: secondInviteId,
      kind: "invite",
      workspaceId,
    }),
    {
      createdByMemberId: adminId,
      email: invitedEmail,
      expiresAt: new Date(startedAt.getTime() + hour + 1_000 + 2 * day),
      id: secondInviteId,
      kind: "invite",
      memberId: null,
      role: "reviewer",
      workspaceId,
    },
  );

  const invitedId = `invited_${name}`;
  const acceptedAt = new Date(startedAt.getTime() + 2 * hour);
  assert.equal(
    await harness.repository.acceptInvitation({
      acceptedAt,
      displayName: "Ivy Invited",
      invitationId: firstInviteId,
      memberId: `unused_${name}`,
      password: password("c"),
      workspaceId,
    }),
    false,
  );
  assert.equal(
    await harness.repository.acceptInvitation({
      acceptedAt,
      displayName: "Ivy Invited",
      invitationId: secondInviteId,
      memberId: invitedId,
      password: password("c"),
      workspaceId,
    }),
    true,
  );
  assert.equal(
    await harness.repository.acceptInvitation({
      acceptedAt: new Date(acceptedAt.getTime() + 1),
      displayName: "Replay",
      invitationId: secondInviteId,
      memberId: `replay_${name}`,
      password: password("d"),
      workspaceId,
    }),
    false,
  );
  assert.equal(
    await harness.repository.findActiveInvitationByIdentity({
      checkedAt: new Date(acceptedAt.getTime() + 1),
      id: secondInviteId,
      kind: "invite",
      workspaceId,
    }),
    null,
  );
  assert.equal(
    (await harness.repository.findCredential(workspaceId, invitedEmail))?.role,
    "reviewer",
  );

  const invitedSessionId = sessionId("D");
  assert.equal(
    await harness.repository.createSession({
      ...actor(workspaceId, invitedId, invitedSessionId),
      createdAt: new Date(startedAt.getTime() + 3 * hour),
      expiresAt: new Date(startedAt.getTime() + 11 * hour),
      expectedPassword: password("c"),
    }),
    true,
  );
  const firstResetId = `reset_one_${name}`;
  const secondResetId = `reset_two_${name}`;
  assert.equal(
    await harness.repository.replaceCredentialReset({
      actor: adminActor,
      createdAt: new Date(startedAt.getTime() + 3 * hour + 1_000),
      expiresAt: new Date(startedAt.getTime() + 4 * hour + 1_000),
      id: firstResetId,
      memberId: invitedId,
      tokenDigest: "3".repeat(64),
    }),
    "changed",
  );
  assert.equal(
    await harness.repository.findActiveSession({
      ...actor(workspaceId, invitedId, invitedSessionId),
      checkedAt: new Date(startedAt.getTime() + 3 * hour + 2_000),
    }),
    null,
  );
  assert.equal(
    await harness.repository.replaceCredentialReset({
      actor: adminActor,
      createdAt: new Date(startedAt.getTime() + 3 * hour + 2_000),
      expiresAt: new Date(startedAt.getTime() + 4 * hour + 2_000),
      id: secondResetId,
      memberId: invitedId,
      tokenDigest: "4".repeat(64),
    }),
    "changed",
  );
  assert.deepEqual(await harness.invitationState(firstResetId), {
    accepted: false,
    revoked: true,
  });
  assert.deepEqual(
    await harness.repository.findActiveInvitationByIdentity({
      checkedAt: new Date(startedAt.getTime() + 3 * hour + 3_000),
      id: secondResetId,
      kind: "credential_reset",
      workspaceId,
    }),
    {
      createdByMemberId: adminId,
      email: invitedEmail,
      expiresAt: new Date(startedAt.getTime() + 4 * hour + 2_000),
      id: secondResetId,
      kind: "credential_reset",
      memberId: invitedId,
      role: null,
      workspaceId,
    },
  );

  const betweenResetSession = sessionId("E");
  assert.equal(
    await harness.repository.createSession({
      createdAt: new Date(startedAt.getTime() + 3 * hour + 3_000),
      expiresAt: new Date(startedAt.getTime() + 11 * hour),
      expectedPassword: password("c"),
      memberId: invitedId,
      sessionId: betweenResetSession,
      workspaceId,
    }),
    true,
  );
  assert.equal(
    await harness.repository.acceptCredentialReset({
      acceptedAt: new Date(startedAt.getTime() + 3 * hour + 4_000),
      invitationId: firstResetId,
      password: password("e"),
      workspaceId,
    }),
    false,
  );
  assert.equal(
    await harness.repository.acceptCredentialReset({
      acceptedAt: new Date(startedAt.getTime() + 3 * hour + 5_000),
      invitationId: secondResetId,
      password: password("f"),
      workspaceId,
    }),
    true,
  );
  assert.equal(
    await harness.repository.acceptCredentialReset({
      acceptedAt: new Date(startedAt.getTime() + 3 * hour + 6_000),
      invitationId: secondResetId,
      password: password("g"),
      workspaceId,
    }),
    false,
  );
  assert.equal(
    await harness.repository.findActiveSession({
      checkedAt: new Date(startedAt.getTime() + 3 * hour + 7_000),
      memberId: invitedId,
      sessionId: betweenResetSession,
      workspaceId,
    }),
    null,
  );
  assert.deepEqual(
    (await harness.repository.findCredential(workspaceId, invitedEmail))?.password,
    password("f"),
  );

  const racingResetId = `reset_race_${name}`;
  const racingResetAt = new Date(startedAt.getTime() + 3 * hour + 7_000);
  assert.equal(
    await harness.repository.replaceCredentialReset({
      actor: adminActor,
      createdAt: racingResetAt,
      expiresAt: new Date(racingResetAt.getTime() + hour),
      id: racingResetId,
      memberId: invitedId,
      tokenDigest: "5".repeat(64),
    }),
    "changed",
  );
  const racingSessionId = sessionId("N");
  const [resetAccepted] = await Promise.all([
    harness.repository.acceptCredentialReset({
      acceptedAt: new Date(racingResetAt.getTime() + 1_000),
      invitationId: racingResetId,
      password: password("h"),
      workspaceId,
    }),
    harness.repository.createSession({
      createdAt: new Date(racingResetAt.getTime() + 1_000),
      expiresAt: new Date(racingResetAt.getTime() + 8 * hour),
      expectedPassword: password("f"),
      memberId: invitedId,
      sessionId: racingSessionId,
      workspaceId,
    }),
  ]);
  assert.equal(resetAccepted, true);
  assert.equal(
    await harness.repository.findActiveSession({
      checkedAt: new Date(racingResetAt.getTime() + 2_000),
      memberId: invitedId,
      sessionId: racingSessionId,
      workspaceId,
    }),
    null,
  );
  assert.equal(
    await harness.repository.createSession({
      createdAt: new Date(racingResetAt.getTime() + 2_000),
      expiresAt: new Date(racingResetAt.getTime() + 8 * hour),
      expectedPassword: password("f"),
      memberId: invitedId,
      sessionId: sessionId("O"),
      workspaceId,
    }),
    false,
  );

  const reviewerSession = sessionId("F");
  await harness.repository.createSession({
    createdAt: new Date(startedAt.getTime() + 4 * hour),
    expiresAt: new Date(startedAt.getTime() + 12 * hour),
    expectedPassword: password("a"),
    memberId: reviewerId,
    sessionId: reviewerSession,
    workspaceId,
  });
  assert.equal(
    await harness.repository.listMembers({
      checkedAt: new Date(startedAt.getTime() + 4 * hour + 500),
      memberId: reviewerId,
      sessionId: reviewerSession,
      workspaceId,
    }),
    null,
  );
  assert.equal(
    await harness.repository.changeMemberRole({
      actor: adminActor,
      changedAt: new Date(startedAt.getTime() + 4 * hour + 1_000),
      memberId: reviewerId,
      role: "editor",
    }),
    "changed",
  );
  assert.equal(
    await harness.repository.findActiveSession({
      checkedAt: new Date(startedAt.getTime() + 4 * hour + 2_000),
      memberId: reviewerId,
      sessionId: reviewerSession,
      workspaceId,
    }),
    null,
  );
  const reviewerSessionAfterRole = sessionId("G");
  await harness.repository.createSession({
    createdAt: new Date(startedAt.getTime() + 4 * hour + 3_000),
    expiresAt: new Date(startedAt.getTime() + 12 * hour),
    expectedPassword: password("a"),
    memberId: reviewerId,
    sessionId: reviewerSessionAfterRole,
    workspaceId,
  });
  assert.equal(
    await harness.repository.changeMemberRole({
      actor: adminActor,
      changedAt: new Date(startedAt.getTime() + 4 * hour + 4_000),
      memberId: reviewerId,
      role: "editor",
    }),
    "unchanged",
  );
  assert.notEqual(
    await harness.repository.findActiveSession({
      checkedAt: new Date(startedAt.getTime() + 4 * hour + 5_000),
      memberId: reviewerId,
      sessionId: reviewerSessionAfterRole,
      workspaceId,
    }),
    null,
  );

  const editorSession = sessionId("H");
  await harness.repository.createSession({
    createdAt: new Date(startedAt.getTime() + 5 * hour),
    expiresAt: new Date(startedAt.getTime() + 13 * hour),
    expectedPassword: password("a"),
    memberId: editorId,
    sessionId: editorSession,
    workspaceId,
  });
  const firstGrantId = grantId("I");
  await harness.createPreview(workspaceId, editorId, firstGrantId);
  const disabledAt = new Date(startedAt.getTime() + 5 * hour + 1_000);
  assert.equal(
    await harness.repository.changeMemberStatus({
      actor: adminActor,
      changedAt: disabledAt,
      memberId: editorId,
      status: "disabled",
    }),
    "changed",
  );
  assert.equal(
    await harness.repository.findActiveSession({
      checkedAt: new Date(disabledAt.getTime() + 1),
      memberId: editorId,
      sessionId: editorSession,
      workspaceId,
    }),
    null,
  );
  assert.deepEqual(await harness.previewState(firstGrantId), {
    revokedAt: disabledAt,
    revokedByMemberId: adminId,
  });
  const disabledMembers = await harness.repository.listMembers({
    ...adminActor,
    checkedAt: new Date(disabledAt.getTime() + 1),
  });
  assert.equal(
    disabledMembers?.find((listedMember) => listedMember.memberId === editorId)?.status,
    "disabled",
  );
  assert.equal(
    await harness.repository.createSession({
      createdAt: new Date(disabledAt.getTime() + 1),
      expiresAt: new Date(disabledAt.getTime() + 8 * hour),
      expectedPassword: password("a"),
      memberId: editorId,
      sessionId: sessionId("M"),
      workspaceId,
    }),
    false,
  );
  assert.equal(
    await harness.repository.changeMemberStatus({
      actor: adminActor,
      changedAt: new Date(disabledAt.getTime() + 1_000),
      memberId: editorId,
      status: "active",
    }),
    "changed",
  );
  const secondGrantId = grantId("J");
  await harness.createPreview(workspaceId, editorId, secondGrantId);
  assert.equal(
    await harness.repository.changeMemberRole({
      actor: adminActor,
      changedAt: new Date(disabledAt.getTime() + 2_000),
      memberId: editorId,
      role: "reviewer",
    }),
    "changed",
  );
  assert.deepEqual(await harness.previewState(secondGrantId), {
    revokedAt: null,
    revokedByMemberId: null,
  });

  await assert.rejects(
    () => harness.deleteMember(editorId),
    /MEMBER_DELETE_FORBIDDEN/u,
  );

  await harness.createMember({
    createdByMemberId: adminId,
    displayName: "Alex Admin",
    email: `admin-two-${name}@example.com`,
    id: secondAdminId,
    role: "administrator",
    workspaceId,
  });
  const secondAdminSession = sessionId("K");
  await harness.repository.createSession({
    createdAt: new Date(startedAt.getTime() + 6 * hour),
    expiresAt: new Date(startedAt.getTime() + 14 * hour),
    expectedPassword: password("a"),
    memberId: secondAdminId,
    sessionId: secondAdminSession,
    workspaceId,
  });
  const raceResults = await Promise.all([
    harness.repository.changeMemberRole({
      actor: adminActor,
      changedAt: new Date(startedAt.getTime() + 6 * hour + 1_000),
      memberId: secondAdminId,
      role: "editor",
    }),
    harness.repository.changeMemberRole({
      actor: actor(workspaceId, secondAdminId, secondAdminSession),
      changedAt: new Date(startedAt.getTime() + 6 * hour + 2_000),
      memberId: adminId,
      role: "editor",
    }),
  ]);
  assert.equal(raceResults.filter((result) => result === "changed").length, 1);
  assert.equal(await harness.activeAdministratorCount(workspaceId), 1);

  assert.ok((await harness.childCount(workspaceId)) > 0);
  await harness.deleteWorkspace(workspaceId);
  assert.equal(await harness.childCount(workspaceId), 0);
}

type D1Bound = Readonly<{
  all(): Promise<unknown>;
  execute(): unknown;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}>;

function createD1Facade(client: Database.Database) {
  const result = (results: unknown[], changes = 0) => ({
    meta: { changes },
    results,
    success: true,
  });
  const d1 = {
    prepare(source: string) {
      return {
        bind(...parameters: unknown[]): D1Bound {
          const returnsRows =
            /^\s*(?:select|with)\b/iu.test(source) || /\breturning\b/iu.test(source);
          const execute = () => {
            if (returnsRows) {
              return result(client.prepare(source).all(...parameters) as unknown[]);
            }
            const mutation = client.prepare(source).run(...parameters);
            return result([], mutation.changes);
          };
          return {
            async all() {
              return execute();
            },
            execute,
            async first<T>() {
              return (client.prepare(source).get(...parameters) as T | undefined) ?? null;
            },
            async run() {
              return execute();
            },
          };
        },
      };
    },
    async batch(statements: readonly D1Bound[]) {
      return client.transaction((items: readonly D1Bound[]) =>
        items.map((statement) => statement.execute()),
      )(statements);
    },
  } as unknown as AnyD1Database;
  return createD1Database(d1, { schema: sqliteSchema });
}

function sqliteHarness(useD1: boolean): Harness {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const localDatabase = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(localDatabase, {
    migrationsFolder: path.join(process.cwd(), "drizzle/sqlite"),
  });
  const database = useD1 ? createD1Facade(client) : localDatabase;
  const repository = createSqliteMemberRepository(database);

  return {
    async activeAdministratorCount(workspaceId) {
      const result = client
        .prepare(
          "select count(*) as count from workspace_members where workspace_id = ? and role = 'administrator' and status = 'active'",
        )
        .get(workspaceId) as { count: number };
      return result.count;
    },
    async childCount(workspaceId) {
      let count = 0;
      for (const table of [
        "workspace_members",
        "admin_sessions",
        "member_invitations",
        "article_preview_grants",
      ]) {
        const result = client
          .prepare(`select count(*) as count from ${table} where workspace_id = ?`)
          .get(workspaceId) as { count: number };
        count += result.count;
      }
      return count;
    },
    async close() {
      client.close();
    },
    async createMember(member) {
      client
        .prepare(
          `insert into workspace_members (
             id, workspace_id, normalized_email, display_name, role, status,
             password_salt, password_digest, password_iterations,
             created_by_member_id, created_at, updated_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          member.id,
          member.workspaceId,
          member.email,
          member.displayName,
          member.role,
          member.status ?? "active",
          password("a").salt,
          password("a").digest,
          password("a").iterations,
          member.createdByMemberId,
          startedAt.getTime(),
          startedAt.getTime(),
        );
    },
    async createPreview(workspaceId, memberId, id) {
      const categoryId = `category_${workspaceId}`;
      const articleId = `article_${workspaceId}`;
      const revisionId = `revision_${workspaceId}`;
      client
        .prepare(
          "insert or ignore into categories (id, workspace_id, slug, name) values (?, ?, 'member-test', 'Member test')",
        )
        .run(categoryId, workspaceId);
      client
        .prepare(
          `insert or ignore into articles (
             id, workspace_id, category_id, slug, title, mdx, status, is_faq,
             author_name, position, created_at, updated_at
           ) values (?, ?, ?, 'member-test', 'Member test', '# Member test',
                     'draft', 0, 'OPAS', 0, ?, ?)`,
        )
        .run(articleId, workspaceId, categoryId, startedAt.getTime(), startedAt.getTime());
      client
        .prepare(
          `insert or ignore into article_revisions (
             id, workspace_id, article_id, revision_number, category_id,
             category_slug, category_name, slug, title, mdx, is_faq,
             author_name, position, revision_hash, change_kind,
             created_by_member_id, created_at
           ) values (?, ?, ?, 1, ?, 'member-test', 'Member test', 'member-test',
                     'Member test', '# Member test', 0, 'OPAS', 0, ?, 'manual', ?, ?)`,
        )
        .run(
          revisionId,
          workspaceId,
          articleId,
          categoryId,
          "a".repeat(64),
          memberId,
          startedAt.getTime(),
        );
      client
        .prepare(
          `insert into article_preview_grants (
             id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
           ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, workspaceId, revisionId, memberId, startedAt.getTime() + 7 * day, startedAt.getTime());
    },
    async createWorkspace(id) {
      client
        .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
        .run(id, id, id);
    },
    async deleteMember(memberId) {
      client.prepare("delete from workspace_members where id = ?").run(memberId);
    },
    async deleteWorkspace(workspaceId) {
      client.prepare("delete from workspaces where id = ?").run(workspaceId);
    },
    async invitationState(id) {
      const result = client
        .prepare(
          "select accepted_at as acceptedAt, revoked_at as revokedAt from member_invitations where id = ?",
        )
        .get(id) as { acceptedAt: number | null; revokedAt: number | null } | undefined;
      return result
        ? { accepted: result.acceptedAt !== null, revoked: result.revokedAt !== null }
        : null;
    },
    async previewState(id) {
      const result = client
        .prepare(
          "select revoked_at as revokedAt, revoked_by_member_id as revokedByMemberId from article_preview_grants where id = ?",
        )
        .get(id) as
        | { revokedAt: number | null; revokedByMemberId: string | null }
        | undefined;
      return result
        ? {
            revokedAt: result.revokedAt === null ? null : new Date(result.revokedAt),
            revokedByMemberId: result.revokedByMemberId,
          }
        : null;
    },
    repository,
    async sessionCount(workspaceId) {
      const result = client
        .prepare("select count(*) as count from admin_sessions where workspace_id = ?")
        .get(workspaceId) as { count: number };
      return result.count;
    },
  };
}

async function postgresHarness(): Promise<Harness> {
  const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const database = createPostgresDatabase(pool, { schema: postgresSchema });
  await migratePostgres(database, {
    migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
  });
  const repository = createPostgresMemberRepository(database);

  return {
    async activeAdministratorCount(workspaceId) {
      const result = await pool.query<{ count: string }>(
        "select count(*) as count from workspace_members where workspace_id = $1 and role = 'administrator' and status = 'active'",
        [workspaceId],
      );
      return Number(result.rows[0]?.count);
    },
    async childCount(workspaceId) {
      let count = 0;
      for (const table of [
        "workspace_members",
        "admin_sessions",
        "member_invitations",
        "article_preview_grants",
      ]) {
        const result = await pool.query<{ count: string }>(
          `select count(*) as count from ${table} where workspace_id = $1`,
          [workspaceId],
        );
        count += Number(result.rows[0]?.count);
      }
      return count;
    },
    async close() {
      await pool.end();
      await container.stop();
    },
    async createMember(member) {
      const verifier = password("a");
      await pool.query(
        `insert into workspace_members (
           id, workspace_id, normalized_email, display_name, role, status,
           password_salt, password_digest, password_iterations,
           created_by_member_id, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          member.id,
          member.workspaceId,
          member.email,
          member.displayName,
          member.role,
          member.status ?? "active",
          verifier.salt,
          verifier.digest,
          verifier.iterations,
          member.createdByMemberId,
          startedAt,
        ],
      );
    },
    async createPreview(workspaceId, memberId, id) {
      const categoryId = `category_${workspaceId}`;
      const articleId = `article_${workspaceId}`;
      const revisionId = `revision_${workspaceId}`;
      await pool.query(
        "insert into categories (id, workspace_id, slug, name) values ($1, $2, 'member-test', 'Member test') on conflict do nothing",
        [categoryId, workspaceId],
      );
      await pool.query(
        `insert into articles (
           id, workspace_id, category_id, slug, title, mdx, status, is_faq,
           author_name, position, created_at, updated_at
         ) values ($1, $2, $3, 'member-test', 'Member test', '# Member test',
                   'draft', false, 'OPAS', 0, $4, $4)
         on conflict do nothing`,
        [articleId, workspaceId, categoryId, startedAt],
      );
      await pool.query(
        `insert into article_revisions (
           id, workspace_id, article_id, revision_number, category_id,
           category_slug, category_name, slug, title, mdx, is_faq,
           author_name, position, revision_hash, change_kind,
           created_by_member_id, created_at
         ) values ($1, $2, $3, 1, $4, 'member-test', 'Member test', 'member-test',
                   'Member test', '# Member test', false, 'OPAS', 0, $5, 'manual', $6, $7)
         on conflict do nothing`,
        [
          revisionId,
          workspaceId,
          articleId,
          categoryId,
          "a".repeat(64),
          memberId,
          startedAt,
        ],
      );
      await pool.query(
        `insert into article_preview_grants (
           id, workspace_id, revision_id, created_by_member_id, expires_at, created_at
         ) values ($1, $2, $3, $4, $5, $6)`,
        [id, workspaceId, revisionId, memberId, new Date(startedAt.getTime() + 7 * day), startedAt],
      );
    },
    async createWorkspace(id) {
      await pool.query("insert into workspaces (id, slug, name) values ($1, $1, $1)", [id]);
    },
    async deleteMember(memberId) {
      await pool.query("delete from workspace_members where id = $1", [memberId]);
    },
    async deleteWorkspace(workspaceId) {
      await pool.query("delete from workspaces where id = $1", [workspaceId]);
    },
    async invitationState(id) {
      const result = await pool.query<{ acceptedAt: Date | null; revokedAt: Date | null }>(
        'select accepted_at as "acceptedAt", revoked_at as "revokedAt" from member_invitations where id = $1',
        [id],
      );
      const row = result.rows[0];
      return row
        ? { accepted: row.acceptedAt !== null, revoked: row.revokedAt !== null }
        : null;
    },
    async previewState(id) {
      const result = await pool.query<{
        revokedAt: Date | null;
        revokedByMemberId: string | null;
      }>(
        'select revoked_at as "revokedAt", revoked_by_member_id as "revokedByMemberId" from article_preview_grants where id = $1',
        [id],
      );
      return result.rows[0] ?? null;
    },
    repository,
    async sessionCount(workspaceId) {
      const result = await pool.query<{ count: string }>(
        "select count(*) as count from admin_sessions where workspace_id = $1",
        [workspaceId],
      );
      return Number(result.rows[0]?.count);
    },
  };
}

test("member repository passes on local SQLite", async () => {
  const harness = sqliteHarness(false);
  try {
    await exerciseMemberRepository("sqlite", harness);
  } finally {
    await harness.close();
  }
});

test("member repository passes through D1 transaction batches", async () => {
  const harness = sqliteHarness(true);
  try {
    await exerciseMemberRepository("d1", harness);
  } finally {
    await harness.close();
  }
});

test(
  "member repository passes on Postgres",
  { timeout: 120_000 },
  async () => {
    const harness = await postgresHarness();
    try {
      await exerciseMemberRepository("postgres", harness);
    } finally {
      await harness.close();
    }
  },
);
