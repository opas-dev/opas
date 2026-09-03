// ABOUTME: Defines the fixed durable admission policy for named-member login attempts.
// ABOUTME: Passes only daily keyed digests and bounded timestamps to database repositories.

import {
  loginAdmissionLookupDays,
  type LoginAdmissionDigests,
} from "@/auth/login-admission-digests";
import { assertAuthIdentifier } from "@/auth/security-encoding";

export const loginAdmissionPolicy = Object.freeze({
  cleanupLimit: 100,
  principalFailureLimit: 30,
  principalFailureWindowMilliseconds: 60 * 60 * 1_000,
  sourceAttemptLimit: 20,
  sourceAttemptWindowMilliseconds: 10 * 60 * 1_000,
  sourcePrincipalCooldownMilliseconds: Object.freeze([
    60 * 1_000,
    2 * 60 * 1_000,
    4 * 60 * 1_000,
    8 * 60 * 1_000,
    15 * 60 * 1_000,
  ]),
  sourcePrincipalFailureLimit: 5,
  sourcePrincipalFailureWindowMilliseconds: 15 * 60 * 1_000,
  workspaceAttemptLimit: 600,
  workspaceAttemptWindowMilliseconds: 60 * 1_000,
});

export type LoginAdmissionDigestKeys = Readonly<{
  principal: string;
  source: string;
  sourcePrincipal: string;
  workspace: string;
}>;

export type LoginAdmissionReservation = Readonly<{
  attemptedAt: Date;
  current: LoginAdmissionDigestKeys;
  previous: LoginAdmissionDigestKeys;
  workspaceId: string;
}>;

export type LoginAdmissionCompletion = LoginAdmissionReservation &
  Readonly<{
    completedAt: Date;
  }>;

export type LoginAdmissionPermit = LoginAdmissionReservation;

export type LoginAdmissionRejectionReason =
  | "integrity"
  | "source"
  | "source_principal"
  | "workspace";

export type LoginAdmissionReservationResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason: LoginAdmissionRejectionReason;
      retryAfterAt: Date;
    }>;

export type LoginAdmissionResult =
  | Readonly<{ accepted: true; permit: LoginAdmissionPermit }>
  | Extract<LoginAdmissionReservationResult, { accepted: false }>;

export type LoginAdmissionFailureState = Readonly<{
  blockedUntil: Date;
  failureCount: number;
  principalRiskCount: number;
  principalRiskElevated: boolean;
}>;

export interface LoginAdmissionRepository {
  clearFailure(completion: LoginAdmissionCompletion): Promise<number>;
  recordFailure(
    completion: LoginAdmissionCompletion,
  ): Promise<LoginAdmissionFailureState>;
  reserve(
    reservation: LoginAdmissionReservation,
  ): Promise<LoginAdmissionReservationResult>;
}

export function isPrincipalLoginRiskElevated(failureCount: number): boolean {
  if (!Number.isSafeInteger(failureCount) || failureCount < 0) {
    throw new Error("INVALID_LOGIN_ADMISSION_FAILURE_COUNT");
  }
  return failureCount >= loginAdmissionPolicy.principalFailureLimit;
}

export type LoginAdmissionInput = Readonly<{
  attemptedAt: Date;
  current: LoginAdmissionDigests;
  previous: LoginAdmissionDigests;
  workspaceId: string;
}>;

const digestPattern = /^[0-9a-f]{64}$/;

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`INVALID_LOGIN_ADMISSION_${field}`);
  }
  return new Date(value);
}

function digestKeys(value: LoginAdmissionDigests): LoginAdmissionDigestKeys {
  for (const digest of [
    value.principal,
    value.source,
    value.sourcePrincipal,
    value.workspace,
  ]) {
    if (!digestPattern.test(digest)) {
      throw new Error("INVALID_LOGIN_ADMISSION_DIGEST");
    }
  }
  return Object.freeze({
    principal: value.principal,
    source: value.source,
    sourcePrincipal: value.sourcePrincipal,
    workspace: value.workspace,
  });
}

export function prepareLoginAdmission(
  input: LoginAdmissionInput,
): LoginAdmissionReservation {
  const attemptedAt = validDate(input.attemptedAt, "CLOCK");
  const [currentDay, previousDay] = loginAdmissionLookupDays(attemptedAt);
  if (input.current.day !== currentDay || input.previous.day !== previousDay) {
    throw new Error("INVALID_LOGIN_ADMISSION_DAY_PAIR");
  }

  const current = digestKeys(input.current);
  const previous = digestKeys(input.previous);
  for (const dimension of [
    "principal",
    "source",
    "sourcePrincipal",
    "workspace",
  ] as const) {
    if (current[dimension] === previous[dimension]) {
      throw new Error("INVALID_LOGIN_ADMISSION_KEY_ROTATION");
    }
  }

  return Object.freeze({
    attemptedAt,
    current,
    previous,
    workspaceId: assertAuthIdentifier(input.workspaceId),
  });
}

export async function reserveLoginAttempt(
  repository: LoginAdmissionRepository,
  input: LoginAdmissionInput,
): Promise<LoginAdmissionResult> {
  const permit = prepareLoginAdmission(input);
  const result = await repository.reserve(permit);
  return result.accepted
    ? Object.freeze({ accepted: true as const, permit })
    : result;
}

function completion(
  permit: LoginAdmissionPermit,
  completedAtValue: Date,
): LoginAdmissionCompletion {
  const completedAt = validDate(completedAtValue, "CLOCK");
  if (completedAt.getTime() < permit.attemptedAt.getTime()) {
    throw new Error("INVALID_LOGIN_ADMISSION_CLOCK");
  }
  return Object.freeze({ ...permit, completedAt });
}

export function clearLoginFailure(
  repository: LoginAdmissionRepository,
  permit: LoginAdmissionPermit,
  completedAt: Date,
): Promise<number> {
  return repository.clearFailure(completion(permit, completedAt));
}

export function recordLoginFailure(
  repository: LoginAdmissionRepository,
  permit: LoginAdmissionPermit,
  completedAt: Date,
): Promise<LoginAdmissionFailureState> {
  return repository.recordFailure(completion(permit, completedAt));
}
