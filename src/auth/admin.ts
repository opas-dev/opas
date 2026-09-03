// ABOUTME: Resolves named-member authorization and manages the active administrator cookie.
// ABOUTME: Gives protected entry points one authoritative database-backed capability check.
import "server-only";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { AuthorizationError, type Capability } from "@/auth/capabilities";
import {
  getAdminSessionConfig,
  type AdminSessionConfig,
} from "@/auth/config";
import {
  createDatabaseSessionToken,
  databaseSessionCookieName,
  databaseSessionCookieOptions,
} from "@/auth/database-session";
import {
  authorizeMemberSession,
  MemberSessionError,
} from "@/auth/member-authorization";
import { getMemberRepository } from "@/auth/member-database";
import type { MemberLoginSession } from "@/auth/member-login";
import type { ActiveMemberSession } from "@/auth/member-repository";

const loginPath = "/admin/login";

export async function startAdminSession(
  session: MemberLoginSession,
  config: AdminSessionConfig,
) {
  const { claims, token } = await createDatabaseSessionToken(
    {
      databaseExpiresAt: session.expiresAt,
      memberId: session.memberId,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
    },
    config.sessionSecret,
    config.deploymentId,
    session.createdAt,
  );
  const cookieStore = await cookies();

  cookieStore.set(
    databaseSessionCookieName(config.deploymentId),
    token,
    databaseSessionCookieOptions(claims.expiresAt, session.createdAt),
  );
}

export async function endAdminSession(session: ActiveMemberSession) {
  const revokedAt = new Date();
  await (await getMemberRepository()).revokeSession({
    memberId: session.memberId,
    revokedAt,
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
  });

  const { deploymentId } = getAdminSessionConfig();
  const cookieStore = await cookies();

  cookieStore.set(databaseSessionCookieName(deploymentId), "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/admin",
    priority: "high",
    sameSite: "lax",
    secure: true,
  });
}

export async function requireMemberCapability(
  capability: Capability,
  workspaceId: string,
): Promise<ActiveMemberSession> {
  const { deploymentId, sessionSecret } = getAdminSessionConfig();
  const token = (await cookies()).get(databaseSessionCookieName(deploymentId))?.value;

  try {
    return await authorizeMemberSession(
      {
        capability,
        checkedAt: new Date(),
        deploymentId,
        sessionSecret,
        token,
        workspaceId,
      },
      await getMemberRepository(),
    );
  } catch (error) {
    if (error instanceof MemberSessionError) {
      redirect(loginPath);
    }
    if (error instanceof AuthorizationError) {
      notFound();
    }
    throw error;
  }
}
