// ABOUTME: Derives privacy-preserving login-admission keys for one explicit UTC day.
// ABOUTME: Keeps source addresses and normalized submitted emails out of durable storage and logs.

import {
  assertAuthIdentifier,
  authEncoder,
  canonicalDeploymentId,
  deriveAuthenticationKey,
  encodeLowercaseHex,
} from "@/auth/security-encoding";

export const loginAdmissionDimensions = [
  "source",
  "source_principal",
  "principal",
  "workspace",
] as const;

export type LoginAdmissionDimension = (typeof loginAdmissionDimensions)[number];

export type LoginAdmissionDigests = {
  day: string;
  principal: string;
  source: string;
  sourcePrincipal: string;
  workspace: string;
};

export type CreateLoginAdmissionDigests = {
  canonicalSourceAddress: string;
  day: string;
  deploymentId: string;
  sessionSecret: string;
  submittedEmail: string;
  workspaceId: string;
};

const utcDayPattern = /^\d{4}-\d{2}-\d{2}$/;
const canonicalSourcePattern = /^[0-9a-f:.]{2,64}$/;

export function loginAdmissionUtcDay(now: Date): string {
  const milliseconds = now.getTime();

  if (!Number.isFinite(milliseconds)) {
    throw new Error("INVALID_AUTH_CLOCK");
  }

  return now.toISOString().slice(0, 10);
}

export function loginAdmissionLookupDays(now: Date): readonly [string, string] {
  const currentDay = loginAdmissionUtcDay(now);
  const previousDay = loginAdmissionUtcDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return [currentDay, previousDay];
}

export function normalizeLoginPrincipal(submittedEmail: string): string {
  if (submittedEmail.length > 1280) {
    throw new Error("INVALID_LOGIN_PRINCIPAL");
  }

  const normalized = submittedEmail.trim().toLowerCase();

  if (
    normalized.length === 0 ||
    Array.from(normalized).length > 320 ||
    authEncoder.encode(normalized).byteLength > 1280
  ) {
    throw new Error("INVALID_LOGIN_PRINCIPAL");
  }

  return normalized;
}

function assertUtcDay(day: string): string {
  const parsedDay = new Date(`${day}T00:00:00.000Z`);

  if (
    !utcDayPattern.test(day) ||
    !Number.isFinite(parsedDay.getTime()) ||
    loginAdmissionUtcDay(parsedDay) !== day
  ) {
    throw new Error("INVALID_LOGIN_ADMISSION_DAY");
  }

  return day;
}

function assertCanonicalSource(source: string): string {
  if (!canonicalSourcePattern.test(source)) {
    throw new Error("INVALID_LOGIN_SOURCE");
  }

  return source;
}

async function admissionDigest(
  key: CryptoKey,
  dimension: LoginAdmissionDimension,
  workspaceId: string,
  values: readonly string[],
): Promise<string> {
  const message = authEncoder.encode(
    JSON.stringify(["opas-login-admission-v1", dimension, workspaceId, ...values]),
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return encodeLowercaseHex(digest);
}

export async function createLoginAdmissionDigests(
  input: CreateLoginAdmissionDigests,
): Promise<LoginAdmissionDigests> {
  const day = assertUtcDay(input.day);
  const deploymentId = canonicalDeploymentId(input.deploymentId);
  const workspaceId = assertAuthIdentifier(input.workspaceId);
  const source = assertCanonicalSource(input.canonicalSourceAddress);
  const principal = normalizeLoginPrincipal(input.submittedEmail);
  const key = await deriveAuthenticationKey(
    input.sessionSecret,
    deploymentId,
    `login-admission-v1\0${day}`,
  );
  const [sourceDigest, sourcePrincipalDigest, principalDigest, workspaceDigest] =
    await Promise.all([
      admissionDigest(key, "source", workspaceId, [source]),
      admissionDigest(key, "source_principal", workspaceId, [source, principal]),
      admissionDigest(key, "principal", workspaceId, [principal]),
      admissionDigest(key, "workspace", workspaceId, []),
    ]);

  return {
    day,
    principal: principalDigest,
    source: sourceDigest,
    sourcePrincipal: sourcePrincipalDigest,
    workspace: workspaceDigest,
  };
}
