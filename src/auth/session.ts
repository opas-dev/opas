// ABOUTME: Signs and verifies the short-lived stateless administrator session token.
// ABOUTME: Keeps the cookie payload minimal while enforcing issuer, audience, subject, and expiry.
import { SignJWT, jwtVerify } from "jose";

export const adminSessionCookie = "opas_admin_session";
export const adminSessionLifetimeSeconds = 8 * 60 * 60;

const sessionIssuer = "opas";
const sessionAudience = "opas-admin";
const sessionSubject = "admin";
const encoder = new TextEncoder();

export type AdminSession = {
  expiresAt: Date;
};

function signingKey(secret: string) {
  return encoder.encode(secret);
}

export async function createAdminSessionToken(secret: string, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + adminSessionLifetimeSeconds;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(sessionIssuer)
    .setAudience(sessionAudience)
    .setSubject(sessionSubject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(signingKey(secret));

  return {
    expiresAt: new Date(expiresAt * 1000),
    token,
  };
}

export async function verifyAdminSessionToken(
  token: string | undefined,
  secret: string,
  now = new Date(),
): Promise<AdminSession | null> {
  if (!token) {
    return null;
  }

  try {
    const { payload, protectedHeader } = await jwtVerify(token, signingKey(secret), {
      algorithms: ["HS256"],
      audience: sessionAudience,
      currentDate: now,
      issuer: sessionIssuer,
      maxTokenAge: adminSessionLifetimeSeconds,
      subject: sessionSubject,
    });

    if (protectedHeader.typ !== "JWT" || typeof payload.exp !== "number") {
      return null;
    }

    return { expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}
