// ABOUTME: Freezes the signed article-preview claim and cookie contract.
// ABOUTME: Keeps preview grants exact-revision, deployment-specific, and independently keyed.

import { SignJWT, jwtVerify } from "jose";

import {
  assertAuthIdentifier,
  canonicalDeploymentId,
  createRandomBytes,
  decodeBase64Url,
  deploymentCookieScope,
  deriveAuthenticationKey,
  encodeBase64Url,
  epochSeconds,
  hasCanonicalJwtEncoding,
  type RandomBytes,
} from "@/auth/security-encoding";

export const articlePreviewTokenContract = Object.freeze({
  algorithm: "HS256",
  audience: "opas-article-preview",
  issuer: "opas",
  lifetimeSeconds: 7 * 24 * 60 * 60,
  cookiePath: "/preview",
  claims: Object.freeze({
    deploymentId: "did",
    grantId: "jti",
    revisionId: "rid",
    workspaceId: "wid",
  }),
});

export type ArticlePreviewClaims = {
  deploymentId: string;
  grantId: string;
  workspaceId: string;
  revisionId: string;
  issuedAt: Date;
  expiresAt: Date;
};

export type CreateArticlePreviewToken = Readonly<{
  databaseExpiresAt: Date;
  grantId: string;
  revisionId: string;
  workspaceId: string;
}>;

const grantIdBytes = 32;
const maximumTokenCharacters = 2_048;
const requiredClaimNames = ["aud", "did", "exp", "iat", "iss", "jti", "rid", "wid"];

function previewKeyPurpose() {
  return "article-preview-v1";
}

function articlePreviewGrantId(value: string) {
  const identifier = assertAuthIdentifier(value);
  if (decodeBase64Url(identifier)?.byteLength !== grantIdBytes) {
    throw new Error("INVALID_PREVIEW_GRANT_ID");
  }
  return identifier;
}

function hasExactClaims(payload: Record<string, unknown>) {
  return (
    Object.keys(payload).sort().join("\0") === requiredClaimNames.join("\0") &&
    typeof payload.did === "string" &&
    typeof payload.jti === "string" &&
    typeof payload.rid === "string" &&
    typeof payload.wid === "string" &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp)
  );
}

export function createArticlePreviewGrantId(randomBytes?: RandomBytes) {
  return encodeBase64Url(createRandomBytes(grantIdBytes, randomBytes));
}

export function articlePreviewCookieName(deploymentId: string) {
  return `opas_preview_${deploymentCookieScope(deploymentId)}`;
}

export function articlePreviewCookieOptions(
  tokenExpiresAt: Date,
  databaseExpiresAt: Date,
  now = new Date(),
) {
  const boundedExpiry = new Date(
    Math.min(
      epochSeconds(tokenExpiresAt),
      epochSeconds(databaseExpiresAt),
      epochSeconds(now) + articlePreviewTokenContract.lifetimeSeconds,
    ) * 1_000,
  );

  return {
    expires: boundedExpiry,
    httpOnly: true,
    maxAge: Math.max(0, epochSeconds(boundedExpiry) - epochSeconds(now)),
    path: articlePreviewTokenContract.cookiePath,
    priority: "high" as const,
    sameSite: "lax" as const,
    secure: true,
  };
}

export async function createArticlePreviewToken(
  input: CreateArticlePreviewToken,
  secret: string,
  deploymentId: string,
  now = new Date(),
): Promise<{ claims: ArticlePreviewClaims; token: string }> {
  const issuedAt = epochSeconds(now);
  const expiresAt = Math.min(
    issuedAt + articlePreviewTokenContract.lifetimeSeconds,
    epochSeconds(input.databaseExpiresAt),
  );
  if (expiresAt <= issuedAt) throw new Error("INVALID_PREVIEW_EXPIRY");

  const canonicalDeployment = canonicalDeploymentId(deploymentId);
  const grantId = articlePreviewGrantId(input.grantId);
  const revisionId = assertAuthIdentifier(input.revisionId);
  const workspaceId = assertAuthIdentifier(input.workspaceId);
  const key = await deriveAuthenticationKey(
    secret,
    canonicalDeployment,
    previewKeyPurpose(),
  );
  const token = await new SignJWT({
    did: canonicalDeployment,
    rid: revisionId,
    wid: workspaceId,
  })
    .setProtectedHeader({ alg: articlePreviewTokenContract.algorithm, typ: "JWT" })
    .setIssuer(articlePreviewTokenContract.issuer)
    .setAudience(articlePreviewTokenContract.audience)
    .setJti(grantId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);

  return {
    claims: {
      deploymentId: canonicalDeployment,
      expiresAt: new Date(expiresAt * 1_000),
      grantId,
      issuedAt: new Date(issuedAt * 1_000),
      revisionId,
      workspaceId,
    },
    token,
  };
}

export async function verifyArticlePreviewToken(
  token: string | undefined,
  secret: string,
  deploymentId: string,
  now = new Date(),
): Promise<ArticlePreviewClaims | null> {
  if (!token || token.length > maximumTokenCharacters) return null;

  try {
    const canonicalDeployment = canonicalDeploymentId(deploymentId);
    const key = await deriveAuthenticationKey(
      secret,
      canonicalDeployment,
      previewKeyPurpose(),
    );
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: [articlePreviewTokenContract.algorithm],
      audience: articlePreviewTokenContract.audience,
      currentDate: now,
      issuer: articlePreviewTokenContract.issuer,
      maxTokenAge: articlePreviewTokenContract.lifetimeSeconds,
    });
    const nowSeconds = epochSeconds(now);
    if (
      protectedHeader.typ !== "JWT" ||
      !hasExactClaims(payload) ||
      payload.did !== canonicalDeployment ||
      !hasCanonicalJwtEncoding(
        token,
        { alg: articlePreviewTokenContract.algorithm, typ: "JWT" },
        {
          did: payload.did,
          rid: payload.rid,
          wid: payload.wid,
          iss: articlePreviewTokenContract.issuer,
          aud: articlePreviewTokenContract.audience,
          jti: payload.jti,
          iat: payload.iat,
          exp: payload.exp,
        },
      ) ||
      (payload.iat as number) > nowSeconds ||
      (payload.exp as number) <= nowSeconds ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) >
        articlePreviewTokenContract.lifetimeSeconds
    ) {
      return null;
    }

    return {
      deploymentId: canonicalDeployment,
      expiresAt: new Date((payload.exp as number) * 1_000),
      grantId: articlePreviewGrantId(payload.jti as string),
      issuedAt: new Date((payload.iat as number) * 1_000),
      revisionId: assertAuthIdentifier(payload.rid as string),
      workspaceId: assertAuthIdentifier(payload.wid as string),
    };
  } catch {
    return null;
  }
}
