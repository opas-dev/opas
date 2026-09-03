// ABOUTME: Authorizes named members from strict session claims and authoritative database state.
// ABOUTME: Rejects stale identity before applying the current role's exact requested capability.
import { requireCapability, type Capability } from "@/auth/capabilities";
import {
  databaseSessionCookieName,
  verifyDatabaseSessionToken,
} from "@/auth/database-session";
import type {
  ActiveMemberSession,
  MemberRepository,
} from "@/auth/member-repository";

export class MemberSessionError extends Error {
  readonly code = "MEMBER_SESSION_REQUIRED";

  constructor() {
    super("MEMBER_SESSION_REQUIRED");
    this.name = "MemberSessionError";
  }
}

export type MemberAuthorizationRequest = Readonly<{
  capability: Capability;
  checkedAt: Date;
  deploymentId: string;
  sessionSecret: string;
  token: string | undefined;
  workspaceId: string;
}>;

type MemberRequestAuthorization = Omit<MemberAuthorizationRequest, "token">;

export async function authorizeMemberRequest(
  request: Pick<Request, "headers">,
  authorization: MemberRequestAuthorization,
  repository: MemberRepository,
): Promise<ActiveMemberSession> {
  const cookieName = databaseSessionCookieName(authorization.deploymentId);
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((field) => field.trim())
    .filter((field) => field.startsWith(`${cookieName}=`));
  const token =
    matches.length === 1 ? matches[0]?.slice(cookieName.length + 1) : undefined;

  return authorizeMemberSession({ ...authorization, token }, repository);
}

export async function authorizeMemberSession(
  request: MemberAuthorizationRequest,
  repository: MemberRepository,
): Promise<ActiveMemberSession> {
  const claims = await verifyDatabaseSessionToken(
    request.token,
    request.sessionSecret,
    request.deploymentId,
    request.checkedAt,
  );

  if (!claims || claims.workspaceId !== request.workspaceId) {
    throw new MemberSessionError();
  }

  const member = await repository.findActiveSession({
    checkedAt: request.checkedAt,
    memberId: claims.memberId,
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
  });

  if (!member) {
    throw new MemberSessionError();
  }

  requireCapability(member.role, request.capability);
  return member;
}
