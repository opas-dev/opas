// ABOUTME: Coordinates durable admission, password verification, and named-member session creation.
// ABOUTME: Keeps every admitted failure generic while cleaning up sessions that cannot reach a cookie.
import {
  clearLoginFailure,
  recordLoginFailure,
  reserveLoginAttempt,
  type LoginAdmissionRepository,
} from "@/auth/login-admission";
import {
  createLoginAdmissionDigests,
  loginAdmissionLookupDays,
  normalizeLoginPrincipal,
} from "@/auth/login-admission-digests";
import {
  databaseSessionContract,
  createDatabaseSessionId,
} from "@/auth/database-session";
import {
  assertMemberPasswordPolicy,
  MemberPasswordPolicyError,
  verifyMemberPassword,
  type MemberPasswordVerifier,
} from "@/auth/member-password";
import type {
  MemberRepository,
  MemberSessionInput,
} from "@/auth/member-repository";

const invalidAdmissionPrincipal = "invalid-login-principal";
const invalidPasswordCandidate = "invalid-login-password";

export type MemberLoginForm = Readonly<{
  admissionEmail: string;
  normalizedEmail: string | null;
  password: string;
  valid: boolean;
}>;

export type MemberLoginSession = Readonly<{
  createdAt: Date;
  expiresAt: Date;
  memberId: string;
  sessionId: string;
  workspaceId: string;
}>;

export type MemberLoginResult =
  | Readonly<{ authenticated: true; session: MemberLoginSession }>
  | Readonly<{
      authenticated: false;
      cleanupFailed: boolean;
      reason: "admission" | "credentials" | "internal";
    }>;

export type MemberLoginRequest = Readonly<{
  canonicalSourceAddress: string;
  deploymentId: string;
  form: MemberLoginForm;
  sessionSecret: string;
  workspaceId: string;
}>;

export type MemberLoginDependencies = Readonly<{
  admissionRepository: LoginAdmissionRepository;
  clock?: () => Date;
  createSessionId?: () => string;
  memberRepository: MemberRepository;
  startBrowserSession: (session: MemberLoginSession) => Promise<void>;
  verifyPassword?: (
    password: string,
    verifier: MemberPasswordVerifier | null,
  ) => Promise<boolean>;
}>;

function normalizedEmail(value: string): string | null {
  try {
    return normalizeLoginPrincipal(value);
  } catch {
    return null;
  }
}

function boundedPassword(value: string): Readonly<{
  password: string;
  valid: boolean;
}> {
  try {
    assertMemberPasswordPolicy(value);
    return Object.freeze({ password: value, valid: true });
  } catch (error) {
    return Object.freeze({
      password:
        error instanceof MemberPasswordPolicyError &&
        error.code === "PASSWORD_TOO_LONG"
          ? invalidPasswordCandidate
          : value,
      valid: false,
    });
  }
}

function isServerActionMetadata(fieldName: string): boolean {
  return fieldName.startsWith("$ACTION_");
}

export function readMemberLoginForm(formData: FormData): MemberLoginForm {
  const emailValues = formData.getAll("email");
  const passwordValues = formData.getAll("password");
  const keys = [...formData.keys()];
  const email = emailValues.length === 1 && typeof emailValues[0] === "string"
    ? emailValues[0]
    : "";
  const password =
    passwordValues.length === 1 && typeof passwordValues[0] === "string"
      ? passwordValues[0]
      : "";
  const parsedPassword = boundedPassword(password);
  const parsedEmail = email.length <= 1_280 ? normalizedEmail(email) : null;
  const credentialKeys = keys.filter((key) => !isServerActionMetadata(key));
  const hasExactFields =
    credentialKeys.length === 2 &&
    credentialKeys.every((key) => key === "email" || key === "password");
  const valid =
    hasExactFields &&
    parsedEmail !== null &&
    parsedPassword.valid;

  return Object.freeze({
    admissionEmail: parsedEmail ?? invalidAdmissionPrincipal,
    normalizedEmail: parsedEmail,
    password: parsedPassword.password,
    valid,
  });
}

function failedLogin(
  reason: Extract<MemberLoginResult, { authenticated: false }>["reason"],
  cleanupFailed = false,
): MemberLoginResult {
  return Object.freeze({ authenticated: false, cleanupFailed, reason });
}

async function recordFailure(
  repository: LoginAdmissionRepository,
  permit: Parameters<typeof recordLoginFailure>[1],
  completedAt: Date,
) {
  try {
    await recordLoginFailure(repository, permit, completedAt);
    return failedLogin("credentials");
  } catch {
    return failedLogin("internal");
  }
}

async function revokeCreatedSession(
  repository: MemberRepository,
  session: MemberLoginSession,
  revokedAt: Date,
) {
  try {
    const revoked = await repository.revokeSession({
      memberId: session.memberId,
      revokedAt,
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
    });
    return !revoked;
  } catch {
    return true;
  }
}

export async function loginMember(
  request: MemberLoginRequest,
  dependencies: MemberLoginDependencies,
): Promise<MemberLoginResult> {
  const clock = dependencies.clock ?? (() => new Date());
  const verifyPassword = dependencies.verifyPassword ?? verifyMemberPassword;
  const attemptedAt = clock();
  const [currentDay, previousDay] = loginAdmissionLookupDays(attemptedAt);
  let reservation;

  try {
    const [current, previous] = await Promise.all([
      createLoginAdmissionDigests({
        canonicalSourceAddress: request.canonicalSourceAddress,
        day: currentDay,
        deploymentId: request.deploymentId,
        sessionSecret: request.sessionSecret,
        submittedEmail: request.form.admissionEmail,
        workspaceId: request.workspaceId,
      }),
      createLoginAdmissionDigests({
        canonicalSourceAddress: request.canonicalSourceAddress,
        day: previousDay,
        deploymentId: request.deploymentId,
        sessionSecret: request.sessionSecret,
        submittedEmail: request.form.admissionEmail,
        workspaceId: request.workspaceId,
      }),
    ]);
    reservation = await reserveLoginAttempt(dependencies.admissionRepository, {
      attemptedAt,
      current,
      previous,
      workspaceId: request.workspaceId,
    });
  } catch {
    return failedLogin("internal");
  }

  if (!reservation.accepted) {
    return failedLogin("admission");
  }

  let credential = null;
  let credentialLookupFailed = false;
  if (request.form.valid && request.form.normalizedEmail !== null) {
    try {
      credential = await dependencies.memberRepository.findCredential(
        request.workspaceId,
        request.form.normalizedEmail,
      );
    } catch {
      credentialLookupFailed = true;
    }
  }

  const eligibleCredential =
    !credentialLookupFailed && credential?.status === "active"
      ? credential
      : null;
  let passwordMatches = false;
  try {
    passwordMatches = await verifyPassword(
      request.form.password,
      eligibleCredential?.password ?? null,
    );
  } catch {
    return recordFailure(
      dependencies.admissionRepository,
      reservation.permit,
      clock(),
    );
  }

  if (
    !request.form.valid ||
    credentialLookupFailed ||
    !eligibleCredential ||
    !passwordMatches
  ) {
    return recordFailure(
      dependencies.admissionRepository,
      reservation.permit,
      clock(),
    );
  }

  const createdAt = clock();
  const session: MemberLoginSession = Object.freeze({
    createdAt,
    expiresAt: new Date(
      createdAt.getTime() + databaseSessionContract.lifetimeSeconds * 1_000,
    ),
    memberId: eligibleCredential.memberId,
    sessionId: (dependencies.createSessionId ?? createDatabaseSessionId)(),
    workspaceId: eligibleCredential.workspaceId,
  });
  const sessionInput: MemberSessionInput = {
    ...session,
    expectedPassword: eligibleCredential.password,
  };
  let created = false;

  try {
    created = await dependencies.memberRepository.createSession(sessionInput);
  } catch {
    return recordFailure(
      dependencies.admissionRepository,
      reservation.permit,
      clock(),
    );
  }

  if (!created) {
    return recordFailure(
      dependencies.admissionRepository,
      reservation.permit,
      clock(),
    );
  }

  try {
    await clearLoginFailure(
      dependencies.admissionRepository,
      reservation.permit,
      clock(),
    );
    await dependencies.startBrowserSession(session);
  } catch {
    return failedLogin(
      "internal",
      await revokeCreatedSession(
        dependencies.memberRepository,
        session,
        clock(),
      ),
    );
  }

  return Object.freeze({ authenticated: true, session });
}
