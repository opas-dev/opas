// ABOUTME: Signs minimal named-member claims for database-revocable administrator sessions.
// ABOUTME: Enforces fixed token clocks and deployment-scoped cookie names without embedding member metadata.

import { SignJWT, jwtVerify } from "jose";

import {
  assertAuthIdentifier,
  createRandomBytes,
  deploymentCookieScope,
  deriveAuthenticationKey,
  encodeBase64Url,
  epochSeconds,
  hasCanonicalJwtEncoding,
  type RandomBytes,
} from "@/auth/security-encoding";

export const databaseSessionContract = Object.freeze({
  algorithm: "HS256",
  audience: "opas-admin-session",
  issuer: "opas",
  lifetimeSeconds: 8 * 60 * 60,
  sessionIdBytes: 32,
  cookiePath: "/admin",
});

export type DatabaseSessionClaims = {
  expiresAt: Date;
  issuedAt: Date;
  memberId: string;
  sessionId: string;
  workspaceId: string;
};

export type CreateDatabaseSessionToken = {
  databaseExpiresAt: Date;
  memberId: string;
  sessionId: string;
  workspaceId: string;
};

const requiredClaimNames = ["aud", "exp", "iat", "iss", "sid", "sub", "wid"];

function hasExactClaims(payload: Record<string, unknown>): boolean {
  return (
    Object.keys(payload).sort().join("\0") === requiredClaimNames.join("\0") &&
    typeof payload.sub === "string" &&
    typeof payload.sid === "string" &&
    typeof payload.wid === "string" &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp)
  );
}

function sessionCookieMaxAge(expiresAt: Date, now: Date): number {
  return Math.max(0, epochSeconds(expiresAt) - epochSeconds(now));
}

export function createDatabaseSessionId(randomBytes?: RandomBytes): string {
  return encodeBase64Url(createRandomBytes(databaseSessionContract.sessionIdBytes, randomBytes));
}

export function databaseSessionCookieName(deploymentId: string): string {
  return `opas_admin_session_${deploymentCookieScope(deploymentId)}`;
}

export function databaseSessionCookieOptions(expiresAt: Date, now = new Date()) {
  const boundedExpiry = new Date(
    Math.min(
      epochSeconds(expiresAt),
      epochSeconds(now) + databaseSessionContract.lifetimeSeconds,
    ) * 1000,
  );

  return {
    expires: boundedExpiry,
    httpOnly: true,
    maxAge: sessionCookieMaxAge(boundedExpiry, now),
    path: databaseSessionContract.cookiePath,
    priority: "high" as const,
    sameSite: "lax" as const,
    secure: true,
  };
}

export async function createDatabaseSessionToken(
  input: CreateDatabaseSessionToken,
  secret: string,
  deploymentId: string,
  now = new Date(),
): Promise<{ claims: DatabaseSessionClaims; token: string }> {
  const issuedAt = epochSeconds(now);
  const databaseExpiresAt = epochSeconds(input.databaseExpiresAt);
  const expiresAt = Math.min(
    issuedAt + databaseSessionContract.lifetimeSeconds,
    databaseExpiresAt,
  );

  if (expiresAt <= issuedAt) {
    throw new Error("INVALID_SESSION_EXPIRY");
  }

  const memberId = assertAuthIdentifier(input.memberId);
  const sessionId = assertAuthIdentifier(input.sessionId);
  const workspaceId = assertAuthIdentifier(input.workspaceId);
  const key = await deriveAuthenticationKey(secret, deploymentId, "database-session-v1");
  const token = await new SignJWT({ sid: sessionId, wid: workspaceId })
    .setProtectedHeader({ alg: databaseSessionContract.algorithm, typ: "JWT" })
    .setIssuer(databaseSessionContract.issuer)
    .setAudience(databaseSessionContract.audience)
    .setSubject(memberId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);

  return {
    claims: {
      expiresAt: new Date(expiresAt * 1000),
      issuedAt: new Date(issuedAt * 1000),
      memberId,
      sessionId,
      workspaceId,
    },
    token,
  };
}

export async function verifyDatabaseSessionToken(
  token: string | undefined,
  secret: string,
  deploymentId: string,
  now = new Date(),
): Promise<DatabaseSessionClaims | null> {
  if (!token) {
    return null;
  }

  try {
    const key = await deriveAuthenticationKey(secret, deploymentId, "database-session-v1");
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: [databaseSessionContract.algorithm],
      audience: databaseSessionContract.audience,
      currentDate: now,
      issuer: databaseSessionContract.issuer,
      maxTokenAge: databaseSessionContract.lifetimeSeconds,
    });
    const nowSeconds = epochSeconds(now);

    if (
      protectedHeader.typ !== "JWT" ||
      !hasExactClaims(payload) ||
      !hasCanonicalJwtEncoding(
        token,
        { alg: databaseSessionContract.algorithm, typ: "JWT" },
        {
          sid: payload.sid,
          wid: payload.wid,
          iss: databaseSessionContract.issuer,
          aud: databaseSessionContract.audience,
          sub: payload.sub,
          iat: payload.iat,
          exp: payload.exp,
        },
      ) ||
      (payload.iat as number) > nowSeconds ||
      (payload.exp as number) <= nowSeconds ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > databaseSessionContract.lifetimeSeconds
    ) {
      return null;
    }

    return {
      expiresAt: new Date((payload.exp as number) * 1000),
      issuedAt: new Date((payload.iat as number) * 1000),
      memberId: assertAuthIdentifier(payload.sub as string),
      sessionId: assertAuthIdentifier(payload.sid as string),
      workspaceId: assertAuthIdentifier(payload.wid as string),
    };
  } catch {
    return null;
  }
}
