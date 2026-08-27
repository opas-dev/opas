// ABOUTME: Compares submitted administrator credentials without early secret-dependent exits.
// ABOUTME: Normalizes the email and hashes fixed-length values before constant-time comparison.
import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();

async function digestCredential(kind: "email" | "password", value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`${kind}\0${value}`)),
  );
}

function fixedTimeEqual(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export async function adminCredentialsMatch(
  submittedEmail: string,
  submittedPassword: string,
  configuredEmail: string,
  configuredPassword: string,
) {
  const [submittedEmailDigest, configuredEmailDigest, submittedPasswordDigest, configuredPasswordDigest] =
    await Promise.all([
      digestCredential("email", submittedEmail.trim().toLowerCase()),
      digestCredential("email", configuredEmail.trim().toLowerCase()),
      digestCredential("password", submittedPassword),
      digestCredential("password", configuredPassword),
    ]);

  const emailMatches = fixedTimeEqual(submittedEmailDigest, configuredEmailDigest);
  const passwordMatches = fixedTimeEqual(submittedPasswordDigest, configuredPasswordDigest);

  return emailMatches && passwordMatches;
}
