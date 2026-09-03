// ABOUTME: Exchanges one-time member links for scoped cookies and consumes valid acceptances.
// ABOUTME: Rechecks durable invitation state before exposing details or changing credentials.

import {
  createMemberLinkAcceptanceToken,
  digestMemberLinkBearer,
  type MemberLinkAcceptanceClaims,
  type MemberLinkKind,
  verifyMemberLinkAcceptanceToken,
} from "@/auth/member-link-claims";
import {
  createMemberPasswordVerifier,
  MemberPasswordPolicyError,
} from "@/auth/member-password";
import type {
  ActiveMemberInvitation,
  MemberRepository,
} from "@/auth/member-repository";
import {
  assertAuthIdentifier,
  createRandomBytes,
  encodeBase64Url,
  type RandomBytes,
} from "@/auth/security-encoding";

export type MemberAcceptanceConfiguration = Readonly<{
  deploymentId: string;
  sessionSecret: string;
}>;

export type MemberAcceptanceView = Readonly<{
  email: string;
  expiresAt: string;
  kind: MemberLinkKind;
  role: ActiveMemberInvitation["role"];
}>;

export type MemberAcceptanceSession = Readonly<{
  claims: MemberLinkAcceptanceClaims;
  invitation: ActiveMemberInvitation;
  view: MemberAcceptanceView;
}>;

export type MemberAcceptanceExchange = Readonly<{
  acceptanceToken: string;
  expiresAt: Date;
}>;

export type MemberAcceptanceInput =
  | Readonly<{
      displayName: string;
      kind: "invite";
      password: string;
    }>
  | Readonly<{
      kind: "credential_reset";
      password: string;
    }>;

export type MemberAcceptanceOutcome =
  | Readonly<{ outcome: "accepted" }>
  | Readonly<{
      field: "displayName" | "password";
      outcome: "invalid_input";
    }>
  | Readonly<{ outcome: "invalid_link" }>;

export type MemberAcceptanceDependencies = Readonly<{
  clock?: () => Date;
  randomBytes?: RandomBytes;
  repository: MemberRepository;
}>;

function validInvitationShape(
  invitation: ActiveMemberInvitation,
  kind: MemberLinkKind,
) {
  return (
    invitation.kind === kind &&
    (kind === "invite"
      ? invitation.memberId === null && invitation.role !== null
      : invitation.memberId !== null && invitation.role === null)
  );
}

function acceptanceView(
  invitation: ActiveMemberInvitation,
): MemberAcceptanceView {
  return Object.freeze({
    email: invitation.email,
    expiresAt: invitation.expiresAt.toISOString(),
    kind: invitation.kind,
    role: invitation.role,
  });
}

function normalizedDisplayName(value: string): string | null {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    Array.from(normalized).length <= 100 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
  )
    ? normalized
    : null;
}

function memberId(randomBytes?: RandomBytes) {
  return assertAuthIdentifier(
    `member_${encodeBase64Url(createRandomBytes(18, randomBytes))}`,
  );
}

export function parseMemberAcceptanceKind(
  value: string,
): MemberLinkKind | null {
  if (value === "invite") return "invite";
  if (value === "reset") return "credential_reset";
  return null;
}

export async function exchangeMemberLink(
  kind: MemberLinkKind,
  bearer: string,
  configuration: MemberAcceptanceConfiguration,
  dependencies: MemberAcceptanceDependencies,
): Promise<MemberAcceptanceExchange | null> {
  const tokenDigest = await digestMemberLinkBearer(bearer);
  if (!tokenDigest) return null;
  const checkedAt = dependencies.clock?.() ?? new Date();
  const invitation = await dependencies.repository.findActiveInvitation({
    checkedAt,
    kind,
    tokenDigest,
  });
  if (!invitation || !validInvitationShape(invitation, kind)) return null;

  const { claims, token } = await createMemberLinkAcceptanceToken(
    {
      databaseExpiresAt: invitation.expiresAt,
      kind,
      recordId: invitation.id,
      workspaceId: invitation.workspaceId,
    },
    configuration.sessionSecret,
    configuration.deploymentId,
    checkedAt,
  );
  return Object.freeze({ acceptanceToken: token, expiresAt: claims.expiresAt });
}

export async function resolveMemberAcceptance(
  kind: MemberLinkKind,
  acceptanceToken: string | undefined,
  configuration: MemberAcceptanceConfiguration,
  dependencies: MemberAcceptanceDependencies,
): Promise<MemberAcceptanceSession | null> {
  const checkedAt = dependencies.clock?.() ?? new Date();
  const claims = await verifyMemberLinkAcceptanceToken(
    acceptanceToken,
    configuration.sessionSecret,
    configuration.deploymentId,
    kind,
    checkedAt,
  );
  if (!claims) return null;
  const invitation = await dependencies.repository.findActiveInvitationByIdentity({
    checkedAt,
    id: claims.recordId,
    kind,
    workspaceId: claims.workspaceId,
  });
  if (!invitation || !validInvitationShape(invitation, kind)) return null;

  return Object.freeze({
    claims,
    invitation,
    view: acceptanceView(invitation),
  });
}

export async function acceptMemberLink(
  acceptanceToken: string | undefined,
  input: MemberAcceptanceInput,
  configuration: MemberAcceptanceConfiguration,
  dependencies: MemberAcceptanceDependencies,
): Promise<MemberAcceptanceOutcome> {
  const session = await resolveMemberAcceptance(
    input.kind,
    acceptanceToken,
    configuration,
    dependencies,
  );
  if (!session) return Object.freeze({ outcome: "invalid_link" });

  const displayName =
    input.kind === "invite" ? normalizedDisplayName(input.displayName) : null;
  if (input.kind === "invite" && displayName === null) {
    return Object.freeze({ field: "displayName", outcome: "invalid_input" });
  }

  let password;
  try {
    password = await createMemberPasswordVerifier(
      input.password,
      dependencies.randomBytes,
    );
  } catch (error) {
    if (error instanceof MemberPasswordPolicyError) {
      return Object.freeze({ field: "password", outcome: "invalid_input" });
    }
    throw error;
  }

  const acceptedAt = dependencies.clock?.() ?? new Date();
  if (acceptedAt.getTime() >= session.claims.expiresAt.getTime()) {
    return Object.freeze({ outcome: "invalid_link" });
  }
  const accepted = input.kind === "invite"
    ? await dependencies.repository.acceptInvitation({
        acceptedAt,
        displayName: displayName as string,
        invitationId: session.invitation.id,
        memberId: memberId(dependencies.randomBytes),
        password,
        workspaceId: session.invitation.workspaceId,
      })
    : await dependencies.repository.acceptCredentialReset({
        acceptedAt,
        invitationId: session.invitation.id,
        password,
        workspaceId: session.invitation.workspaceId,
      });

  return Object.freeze({ outcome: accepted ? "accepted" : "invalid_link" });
}
