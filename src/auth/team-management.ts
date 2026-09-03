// ABOUTME: Coordinates administrator-owned team listing, invitations, resets, roles, and status changes.
// ABOUTME: Keeps one-time bearers transient while returning small typed outcomes to server entry points.

import { teamRoles, type TeamRole } from "@/auth/capabilities";
import {
  createMemberLinkBearer,
  digestMemberLinkBearer,
  memberLinkContract,
  type MemberLinkKind,
} from "@/auth/member-link-claims";
import {
  memberStatuses,
  type MemberActor,
  type MemberMutationOutcome,
  type MemberRepository,
  type MemberStatus,
  type TeamMemberRecord,
} from "@/auth/member-repository";
import {
  assertAuthIdentifier,
  createRandomBytes,
  decodeBase64Url,
  encodeBase64Url,
  type RandomBytes,
} from "@/auth/security-encoding";
import { resolveSiteOrigin } from "@/site";

export const teamManagementContract = Object.freeze({
  invitationLifetimeSeconds: memberLinkContract.recordLifetimeSeconds.invite,
  resetLifetimeSeconds: memberLinkContract.recordLifetimeSeconds.credential_reset,
});

export type TeamMemberView = Readonly<{
  createdAt: string;
  displayName: string;
  email: string;
  lastLoginAt: string | null;
  memberId: string;
  role: TeamRole;
  status: MemberStatus;
  updatedAt: string;
}>;

export type TeamMemberListResult =
  | Readonly<{ members: readonly TeamMemberView[]; outcome: "listed" }>
  | Readonly<{ outcome: "forbidden" | "unavailable" }>;

export type TeamLinkIssueResult =
  | Readonly<{
      expiresAt: string;
      kind: MemberLinkKind;
      outcome: "created";
      url: string;
    }>
  | Readonly<{
      field: "email" | "member" | "role" | "site";
      outcome: "invalid";
    }>
  | Readonly<{
      outcome: "conflict" | "forbidden" | "not_found" | "unavailable";
    }>;

export type TeamMemberMutationResult =
  | Readonly<{
      field: "member" | "role" | "status";
      outcome: "invalid";
    }>
  | Readonly<{
      outcome: MemberMutationOutcome | "unavailable";
    }>;

export type TeamManagementDependencies = Readonly<{
  clock?: () => Date;
  randomBytes?: RandomBytes;
  repository: MemberRepository;
}>;

export type TeamInvitationInput = Readonly<{
  actor: MemberActor;
  email: unknown;
  role: unknown;
  siteOrigin: unknown;
}>;

export type TeamCredentialResetInput = Readonly<{
  actor: MemberActor;
  memberId: unknown;
  siteOrigin: unknown;
}>;

export type TeamMemberRoleInput = Readonly<{
  actor: MemberActor;
  memberId: unknown;
  role: unknown;
}>;

export type TeamMemberStatusInput = Readonly<{
  actor: MemberActor;
  memberId: unknown;
  status: unknown;
}>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type LinkRecord = Readonly<{
  actor: MemberActor;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  tokenDigest: string;
}>;

function validDate(value: Date): Date | null {
  const milliseconds = value.getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function operationTime(clock: (() => Date) | undefined): Date | null {
  try {
    return validDate(clock?.() ?? new Date());
  } catch {
    return null;
  }
}

function activeActor(actor: MemberActor): MemberActor | null {
  try {
    if (
      typeof actor !== "object" ||
      actor === null ||
      typeof actor.memberId !== "string" ||
      typeof actor.sessionId !== "string" ||
      typeof actor.workspaceId !== "string" ||
      decodeBase64Url(actor.sessionId)?.byteLength !== 32
    ) {
      return null;
    }

    return Object.freeze({
      memberId: assertAuthIdentifier(actor.memberId),
      sessionId: assertAuthIdentifier(actor.sessionId),
      workspaceId: assertAuthIdentifier(actor.workspaceId),
    });
  } catch {
    return null;
  }
}

function targetMemberId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return assertAuthIdentifier(value);
  } catch {
    return null;
  }
}

export function normalizeTeamMemberEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1_280) return null;
  const normalized = value.trim().toLowerCase();

  if (
    normalized.length < 3 ||
    Array.from(normalized).length > 320 ||
    new TextEncoder().encode(normalized).byteLength > 1_280 ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    !emailPattern.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function teamRole(value: unknown): TeamRole | null {
  return typeof value === "string" && (teamRoles as readonly string[]).includes(value)
    ? (value as TeamRole)
    : null;
}

function memberStatus(value: unknown): MemberStatus | null {
  return typeof value === "string" &&
    (memberStatuses as readonly string[]).includes(value)
    ? (value as MemberStatus)
    : null;
}

function acceptanceUrl(siteOrigin: unknown, kind: MemberLinkKind): URL | null {
  if (typeof siteOrigin !== "string") return null;

  try {
    const origin = resolveSiteOrigin(siteOrigin);
    if (origin.length > 2_048) return null;
    return new URL(
      kind === "invite" ? "/admin/accept/invite" : "/admin/accept/reset",
      `${origin}/`,
    );
  } catch {
    return null;
  }
}

function recordId(randomBytes?: RandomBytes): string {
  return assertAuthIdentifier(
    `member_link_${encodeBase64Url(createRandomBytes(18, randomBytes))}`,
  );
}

function memberView(record: TeamMemberRecord): TeamMemberView {
  const createdAt = validDate(record.createdAt);
  const updatedAt = validDate(record.updatedAt);
  const lastLoginAt = record.lastLoginAt === null ? null : validDate(record.lastLoginAt);
  const email = normalizeTeamMemberEmail(record.email);
  const role = teamRole(record.role);
  const status = memberStatus(record.status);
  const memberId = targetMemberId(record.memberId);

  if (
    !createdAt ||
    !updatedAt ||
    (record.lastLoginAt !== null && !lastLoginAt) ||
    !email ||
    email !== record.email ||
    !role ||
    !status ||
    !memberId ||
    typeof record.displayName !== "string" ||
    Array.from(record.displayName).length < 1 ||
    Array.from(record.displayName).length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(record.displayName)
  ) {
    throw new Error("INVALID_TEAM_MEMBER_RECORD");
  }

  return Object.freeze({
    createdAt: createdAt.toISOString(),
    displayName: record.displayName,
    email,
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
    memberId,
    role,
    status,
    updatedAt: updatedAt.toISOString(),
  });
}

function invalidLink(field: "email" | "member" | "role" | "site"): TeamLinkIssueResult {
  return Object.freeze({ field, outcome: "invalid" });
}

function mutationFailure(
  outcome: MemberMutationOutcome | "unavailable",
): TeamMemberMutationResult {
  return Object.freeze({ outcome });
}

function invalidMutation(
  field: "member" | "role" | "status",
): TeamMemberMutationResult {
  return Object.freeze({ field, outcome: "invalid" });
}

async function issueTeamMemberLink(
  kind: MemberLinkKind,
  actor: MemberActor,
  siteOrigin: unknown,
  dependencies: TeamManagementDependencies,
  persist: (record: LinkRecord) => Promise<MemberMutationOutcome>,
): Promise<TeamLinkIssueResult> {
  const url = acceptanceUrl(siteOrigin, kind);
  if (!url) return invalidLink("site");
  const createdAt = operationTime(dependencies.clock);
  if (!createdAt) return Object.freeze({ outcome: "unavailable" });
  const expiresAt = new Date(
    createdAt.getTime() + memberLinkContract.recordLifetimeSeconds[kind] * 1_000,
  );

  try {
    const bearer = createMemberLinkBearer(dependencies.randomBytes);
    const tokenDigest = await digestMemberLinkBearer(bearer);
    if (!tokenDigest) return Object.freeze({ outcome: "unavailable" });
    const outcome = await persist({
      actor,
      createdAt,
      expiresAt,
      id: recordId(dependencies.randomBytes),
      tokenDigest,
    });
    if (outcome !== "changed") {
      if (
        outcome === "forbidden" ||
        (kind === "invite" && outcome === "conflict") ||
        (kind === "credential_reset" && outcome === "not_found")
      ) {
        return Object.freeze({ outcome });
      }
      return Object.freeze({ outcome: "unavailable" });
    }

    url.hash = bearer;
    return Object.freeze({
      expiresAt: expiresAt.toISOString(),
      kind,
      outcome: "created",
      url: url.href,
    });
  } catch {
    return Object.freeze({ outcome: "unavailable" });
  }
}

export async function listTeamMembers(
  actorInput: MemberActor,
  dependencies: TeamManagementDependencies,
): Promise<TeamMemberListResult> {
  const actor = activeActor(actorInput);
  if (!actor) return Object.freeze({ outcome: "forbidden" });
  const checkedAt = operationTime(dependencies.clock);
  if (!checkedAt) return Object.freeze({ outcome: "unavailable" });

  try {
    const records = await dependencies.repository.listMembers({ ...actor, checkedAt });
    if (!records) return Object.freeze({ outcome: "forbidden" });
    return Object.freeze({
      members: Object.freeze(records.map(memberView)),
      outcome: "listed",
    });
  } catch {
    return Object.freeze({ outcome: "unavailable" });
  }
}

export async function issueTeamInvitation(
  input: TeamInvitationInput,
  dependencies: TeamManagementDependencies,
): Promise<TeamLinkIssueResult> {
  const actor = activeActor(input.actor);
  if (!actor) return Object.freeze({ outcome: "forbidden" });
  const email = normalizeTeamMemberEmail(input.email);
  if (!email) return invalidLink("email");
  const role = teamRole(input.role);
  if (!role) return invalidLink("role");
  return issueTeamMemberLink(
    "invite",
    actor,
    input.siteOrigin,
    dependencies,
    (record) => dependencies.repository.replaceInvitation({ ...record, email, role }),
  );
}

export async function issueTeamCredentialReset(
  input: TeamCredentialResetInput,
  dependencies: TeamManagementDependencies,
): Promise<TeamLinkIssueResult> {
  const actor = activeActor(input.actor);
  if (!actor) return Object.freeze({ outcome: "forbidden" });
  const memberId = targetMemberId(input.memberId);
  if (!memberId) return invalidLink("member");
  return issueTeamMemberLink(
    "credential_reset",
    actor,
    input.siteOrigin,
    dependencies,
    (record) => dependencies.repository.replaceCredentialReset({ ...record, memberId }),
  );
}

export async function changeTeamMemberRole(
  input: TeamMemberRoleInput,
  dependencies: TeamManagementDependencies,
): Promise<TeamMemberMutationResult> {
  const actor = activeActor(input.actor);
  if (!actor) return mutationFailure("forbidden");
  const memberId = targetMemberId(input.memberId);
  if (!memberId) return invalidMutation("member");
  const role = teamRole(input.role);
  if (!role) return invalidMutation("role");
  const changedAt = operationTime(dependencies.clock);
  if (!changedAt) return mutationFailure("unavailable");

  try {
    return mutationFailure(
      await dependencies.repository.changeMemberRole({
        actor,
        changedAt,
        memberId,
        role,
      }),
    );
  } catch {
    return mutationFailure("unavailable");
  }
}

export async function changeTeamMemberStatus(
  input: TeamMemberStatusInput,
  dependencies: TeamManagementDependencies,
): Promise<TeamMemberMutationResult> {
  const actor = activeActor(input.actor);
  if (!actor) return mutationFailure("forbidden");
  const memberId = targetMemberId(input.memberId);
  if (!memberId) return invalidMutation("member");
  const status = memberStatus(input.status);
  if (!status) return invalidMutation("status");
  const changedAt = operationTime(dependencies.clock);
  if (!changedAt) return mutationFailure("unavailable");

  try {
    return mutationFailure(
      await dependencies.repository.changeMemberStatus({
        actor,
        changedAt,
        memberId,
        status,
      }),
    );
  } catch {
    return mutationFailure("unavailable");
  }
}
