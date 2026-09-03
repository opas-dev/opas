// ABOUTME: Creates one-time member-link bearers and signs their short acceptance cookies.
// ABOUTME: Separates invitation and credential-reset claims with deployment-bound HKDF keys.

import { SignJWT, jwtVerify } from "jose";

import {
  assertAuthIdentifier,
  createRandomBytes,
  decodeBase64Url,
  deploymentCookieScope,
  deriveAuthenticationKey,
  encodeBase64Url,
  encodeLowercaseHex,
  epochSeconds,
  hasCanonicalJwtEncoding,
  type RandomBytes,
} from "@/auth/security-encoding";

export const memberLinkKinds = ["invite", "credential_reset"] as const;
export type MemberLinkKind = (typeof memberLinkKinds)[number];

export const memberLinkContract = Object.freeze({
  algorithm: "HS256",
  issuer: "opas",
  acceptanceLifetimeSeconds: 15 * 60,
  bearerBytes: 32,
  cookiePath: "/admin/accept",
  recordLifetimeSeconds: Object.freeze({
    invite: 48 * 60 * 60,
    credential_reset: 60 * 60,
  }),
});

export type MemberLinkAcceptanceClaims = {
  expiresAt: Date;
  issuedAt: Date;
  kind: MemberLinkKind;
  recordId: string;
  workspaceId: string;
};

export type CreateMemberLinkAcceptanceToken = {
  databaseExpiresAt: Date;
  kind: MemberLinkKind;
  recordId: string;
  workspaceId: string;
};

const requiredClaimNames = ["aud", "exp", "iat", "iss", "jti", "kind", "wid"];

function audience(kind: MemberLinkKind): string {
  return kind === "invite"
    ? "opas-member-invitation-acceptance"
    : "opas-member-credential-reset-acceptance";
}

function claimPurpose(kind: MemberLinkKind): string {
  return `member-link-acceptance-v1\0${kind}`;
}

function isMemberLinkKind(value: unknown): value is MemberLinkKind {
  return value === "invite" || value === "credential_reset";
}

function assertMemberLinkKind(value: MemberLinkKind): MemberLinkKind {
  if (!isMemberLinkKind(value)) {
    throw new Error("INVALID_MEMBER_LINK_KIND");
  }

  return value;
}

function hasExactClaims(payload: Record<string, unknown>): boolean {
  return (
    Object.keys(payload).sort().join("\0") === requiredClaimNames.join("\0") &&
    typeof payload.jti === "string" &&
    typeof payload.wid === "string" &&
    isMemberLinkKind(payload.kind) &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp)
  );
}

export function createMemberLinkBearer(randomBytes?: RandomBytes): string {
  return encodeBase64Url(createRandomBytes(memberLinkContract.bearerBytes, randomBytes));
}

export async function digestMemberLinkBearer(bearer: string): Promise<string | null> {
  const bytes = decodeBase64Url(bearer);

  if (bytes?.byteLength !== memberLinkContract.bearerBytes) {
    return null;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return encodeLowercaseHex(digest);
}

export function memberLinkAcceptanceCookieName(
  deploymentId: string,
  kind: MemberLinkKind,
): string {
  assertMemberLinkKind(kind);
  const kindScope = kind === "invite" ? "invite" : "reset";
  return `opas_member_${kindScope}_${deploymentCookieScope(deploymentId)}`;
}

export function memberLinkAcceptanceCookieOptions(expiresAt: Date, now = new Date()) {
  const boundedExpiry = new Date(
    Math.min(
      epochSeconds(expiresAt),
      epochSeconds(now) + memberLinkContract.acceptanceLifetimeSeconds,
    ) * 1000,
  );

  return {
    expires: boundedExpiry,
    httpOnly: true,
    maxAge: Math.max(0, epochSeconds(boundedExpiry) - epochSeconds(now)),
    path: memberLinkContract.cookiePath,
    priority: "high" as const,
    sameSite: "lax" as const,
    secure: true,
  };
}

export async function createMemberLinkAcceptanceToken(
  input: CreateMemberLinkAcceptanceToken,
  secret: string,
  deploymentId: string,
  now = new Date(),
): Promise<{ claims: MemberLinkAcceptanceClaims; token: string }> {
  const kind = assertMemberLinkKind(input.kind);
  const issuedAt = epochSeconds(now);
  const expiresAt = Math.min(
    issuedAt + memberLinkContract.acceptanceLifetimeSeconds,
    epochSeconds(input.databaseExpiresAt),
  );

  if (expiresAt <= issuedAt) {
    throw new Error("INVALID_MEMBER_LINK_EXPIRY");
  }

  const recordId = assertAuthIdentifier(input.recordId);
  const workspaceId = assertAuthIdentifier(input.workspaceId);
  const key = await deriveAuthenticationKey(secret, deploymentId, claimPurpose(kind));
  const token = await new SignJWT({ kind, wid: workspaceId })
    .setProtectedHeader({ alg: memberLinkContract.algorithm, typ: "JWT" })
    .setIssuer(memberLinkContract.issuer)
    .setAudience(audience(kind))
    .setJti(recordId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);

  return {
    claims: {
      expiresAt: new Date(expiresAt * 1000),
      issuedAt: new Date(issuedAt * 1000),
      kind,
      recordId,
      workspaceId,
    },
    token,
  };
}

export async function verifyMemberLinkAcceptanceToken(
  token: string | undefined,
  secret: string,
  deploymentId: string,
  expectedKind: MemberLinkKind,
  now = new Date(),
): Promise<MemberLinkAcceptanceClaims | null> {
  if (!token) {
    return null;
  }

  try {
    const key = await deriveAuthenticationKey(secret, deploymentId, claimPurpose(expectedKind));
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: [memberLinkContract.algorithm],
      audience: audience(expectedKind),
      currentDate: now,
      issuer: memberLinkContract.issuer,
      maxTokenAge: memberLinkContract.acceptanceLifetimeSeconds,
    });
    const nowSeconds = epochSeconds(now);

    if (
      protectedHeader.typ !== "JWT" ||
      !hasExactClaims(payload) ||
      payload.kind !== expectedKind ||
      !hasCanonicalJwtEncoding(
        token,
        { alg: memberLinkContract.algorithm, typ: "JWT" },
        {
          kind: payload.kind,
          wid: payload.wid,
          iss: memberLinkContract.issuer,
          aud: audience(expectedKind),
          jti: payload.jti,
          iat: payload.iat,
          exp: payload.exp,
        },
      ) ||
      (payload.iat as number) > nowSeconds ||
      (payload.exp as number) <= nowSeconds ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) >
        memberLinkContract.acceptanceLifetimeSeconds
    ) {
      return null;
    }

    return {
      expiresAt: new Date((payload.exp as number) * 1000),
      issuedAt: new Date((payload.iat as number) * 1000),
      kind: payload.kind as MemberLinkKind,
      recordId: assertAuthIdentifier(payload.jti as string),
      workspaceId: assertAuthIdentifier(payload.wid as string),
    };
  } catch {
    return null;
  }
}
