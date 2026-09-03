// ABOUTME: Defines the persistence boundary for named members, revocable sessions, and one-time credentials.
// ABOUTME: Keeps identity transactions separate from content repositories and the authoring fence.
import type { TeamRole } from "@/auth/capabilities";
import type { MemberPasswordVerifier } from "@/auth/member-password";

export const memberStatuses = ["active", "disabled"] as const;

export type MemberStatus = (typeof memberStatuses)[number];

export type MemberPassword = MemberPasswordVerifier;

export type MemberIdentity = Readonly<{
  displayName: string;
  email: string;
  memberId: string;
  role: TeamRole;
  status: MemberStatus;
  workspaceId: string;
}>;

export type MemberCredential = MemberIdentity &
  Readonly<{
    password: MemberPassword;
  }>;

export type ActiveMemberSession = Omit<MemberIdentity, "status"> &
  Readonly<{
    expiresAt: Date;
    sessionId: string;
  }>;

export type MemberActor = Readonly<{
  memberId: string;
  sessionId: string;
  workspaceId: string;
}>;

export type TeamMemberRecord = Readonly<{
  createdAt: Date;
  displayName: string;
  email: string;
  lastLoginAt: Date | null;
  memberId: string;
  role: TeamRole;
  status: MemberStatus;
  updatedAt: Date;
}>;

export type MemberListRequest = MemberActor &
  Readonly<{
    checkedAt: Date;
  }>;

export type MemberSessionInput = MemberActor &
  Readonly<{
    createdAt: Date;
    expiresAt: Date;
    expectedPassword: MemberPassword;
  }>;

export type MemberSessionLookup = MemberActor &
  Readonly<{
    checkedAt: Date;
  }>;

export type MemberSessionRevocation = MemberActor &
  Readonly<{
    revokedAt: Date;
  }>;

export const memberInvitationKinds = ["invite", "credential_reset"] as const;

export type MemberInvitationKind = (typeof memberInvitationKinds)[number];

export type ActiveMemberInvitation = Readonly<{
  createdByMemberId: string | null;
  email: string;
  expiresAt: Date;
  id: string;
  kind: MemberInvitationKind;
  memberId: string | null;
  role: TeamRole | null;
  workspaceId: string;
}>;

export type InvitationLookup = Readonly<{
  checkedAt: Date;
  kind: MemberInvitationKind;
  tokenDigest: string;
}>;

export type InvitationIdentityLookup = Readonly<{
  checkedAt: Date;
  id: string;
  kind: MemberInvitationKind;
  workspaceId: string;
}>;

export type InvitationIssue = Readonly<{
  actor: MemberActor;
  createdAt: Date;
  email: string;
  expiresAt: Date;
  id: string;
  role: TeamRole;
  tokenDigest: string;
}>;

export type CredentialResetIssue = Readonly<{
  actor: MemberActor;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  memberId: string;
  tokenDigest: string;
}>;

export type InvitationAcceptance = Readonly<{
  acceptedAt: Date;
  displayName: string;
  invitationId: string;
  memberId: string;
  password: MemberPassword;
  workspaceId: string;
}>;

export type CredentialResetAcceptance = Readonly<{
  acceptedAt: Date;
  invitationId: string;
  password: MemberPassword;
  workspaceId: string;
}>;

export type MemberRoleChange = Readonly<{
  actor: MemberActor;
  changedAt: Date;
  memberId: string;
  role: TeamRole;
}>;

export type MemberStatusChange = Readonly<{
  actor: MemberActor;
  changedAt: Date;
  memberId: string;
  status: MemberStatus;
}>;

export type MemberMutationOutcome =
  | "changed"
  | "conflict"
  | "forbidden"
  | "last_administrator"
  | "not_found"
  | "unchanged";

export interface MemberRepository {
  acceptCredentialReset(request: CredentialResetAcceptance): Promise<boolean>;
  acceptInvitation(request: InvitationAcceptance): Promise<boolean>;
  changeMemberRole(request: MemberRoleChange): Promise<MemberMutationOutcome>;
  changeMemberStatus(request: MemberStatusChange): Promise<MemberMutationOutcome>;
  cleanupExpiredSessions(
    workspaceId: string,
    expiredAt: Date,
    limit: number,
  ): Promise<number>;
  createSession(session: MemberSessionInput): Promise<boolean>;
  findActiveInvitation(request: InvitationLookup): Promise<ActiveMemberInvitation | null>;
  findActiveInvitationByIdentity(
    request: InvitationIdentityLookup,
  ): Promise<ActiveMemberInvitation | null>;
  findActiveSession(session: MemberSessionLookup): Promise<ActiveMemberSession | null>;
  findCredential(workspaceId: string, normalizedEmail: string): Promise<MemberCredential | null>;
  listMembers(request: MemberListRequest): Promise<readonly TeamMemberRecord[] | null>;
  replaceCredentialReset(request: CredentialResetIssue): Promise<MemberMutationOutcome>;
  replaceInvitation(request: InvitationIssue): Promise<MemberMutationOutcome>;
  revokeSession(session: MemberSessionRevocation): Promise<boolean>;
}
