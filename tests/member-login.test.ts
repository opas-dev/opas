// ABOUTME: Verifies named-member login admission, credential checks, and session cleanup.
// ABOUTME: Covers bounded forms and one password verification for every admitted attempt.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type {
  LoginAdmissionCompletion,
  LoginAdmissionRepository,
  LoginAdmissionReservation,
  LoginAdmissionReservationResult,
} from "@/auth/login-admission";
import {
  loginMember,
  readMemberLoginForm,
  type MemberLoginSession,
} from "@/auth/member-login";
import type { MemberPasswordVerifier } from "@/auth/member-password";
import type {
  MemberCredential,
  MemberRepository,
  MemberSessionInput,
  MemberSessionRevocation,
} from "@/auth/member-repository";

const workspaceId = "workspace_demo";
const memberId = "member_login";
const sessionId = "S".repeat(43);
const deploymentId = "docs.example.com";
const sessionSecret = "named-member-login-secret-with-32-bytes";
const attemptedAt = new Date("2026-09-03T12:00:00.000Z");
const validPassword = "correct horse battery staple";
const passwordVerifier = Object.freeze({
  digest: "D".repeat(43),
  iterations: 600_000,
  salt: "S".repeat(43),
});

type HarnessOptions = Readonly<{
  clearFailureError?: boolean;
  credential?: MemberCredential | null;
  credentialLookupError?: boolean;
  createSessionResult?: boolean;
  reserveResult?: LoginAdmissionReservationResult;
  revokeSessionError?: boolean;
  revokeSessionResult?: boolean;
  startBrowserSessionError?: boolean;
  verifyResult?: boolean;
}>;

type HarnessCalls = {
  clearFailure: LoginAdmissionCompletion[];
  createSession: MemberSessionInput[];
  findCredential: Array<readonly [string, string]>;
  recordFailure: LoginAdmissionCompletion[];
  reserve: LoginAdmissionReservation[];
  revokeSession: MemberSessionRevocation[];
  startBrowserSession: MemberLoginSession[];
  verifyPassword: Array<readonly [string, MemberPasswordVerifier | null]>;
};

function activeCredential(
  status: MemberCredential["status"] = "active",
): MemberCredential {
  return Object.freeze({
    displayName: "Named Member",
    email: "member@example.com",
    memberId,
    password: passwordVerifier,
    role: "administrator",
    status,
    workspaceId,
  });
}

function loginForm(email = " Member@Example.com ", password = validPassword) {
  const formData = new FormData();
  formData.append("email", email);
  formData.append("password", password);
  return readMemberLoginForm(formData);
}

function createHarness(options: HarnessOptions = {}) {
  const calls: HarnessCalls = {
    clearFailure: [],
    createSession: [],
    findCredential: [],
    recordFailure: [],
    reserve: [],
    revokeSession: [],
    startBrowserSession: [],
    verifyPassword: [],
  };
  const admissionRepository: LoginAdmissionRepository = {
    async clearFailure(completion) {
      calls.clearFailure.push(completion);
      if (options.clearFailureError) throw new Error("clear unavailable");
      return 1;
    },
    async recordFailure(completion) {
      calls.recordFailure.push(completion);
      return {
        blockedUntil: new Date(completion.completedAt.getTime() + 60_000),
        failureCount: 1,
        principalRiskCount: 1,
        principalRiskElevated: false,
      };
    },
    async reserve(reservation) {
      calls.reserve.push(reservation);
      return options.reserveResult ?? { accepted: true };
    },
  };
  const memberRepository = {
    async createSession(session: MemberSessionInput) {
      calls.createSession.push(session);
      return options.createSessionResult ?? true;
    },
    async findCredential(requestWorkspaceId: string, email: string) {
      calls.findCredential.push([requestWorkspaceId, email]);
      if (options.credentialLookupError) throw new Error("lookup unavailable");
      return options.credential === undefined
        ? activeCredential()
        : options.credential;
    },
    async revokeSession(revocation: MemberSessionRevocation) {
      calls.revokeSession.push(revocation);
      if (options.revokeSessionError) throw new Error("revoke unavailable");
      return options.revokeSessionResult ?? true;
    },
  } as MemberRepository;
  let clockTick = 0;

  return {
    calls,
    login: (form = loginForm()) =>
      loginMember(
        {
          canonicalSourceAddress: "192.0.2.10",
          deploymentId,
          form,
          sessionSecret,
          workspaceId,
        },
        {
          admissionRepository,
          clock: () =>
            new Date(attemptedAt.getTime() + clockTick++ * 1_000),
          createSessionId: () => sessionId,
          memberRepository,
          async startBrowserSession(session) {
            calls.startBrowserSession.push(session);
            if (options.startBrowserSessionError) {
              throw new Error("cookie unavailable");
            }
          },
          async verifyPassword(password, verifier) {
            calls.verifyPassword.push([password, verifier]);
            return options.verifyResult ?? true;
          },
        },
      ),
  };
}

test("login forms normalize identity and retain only bounded password input", () => {
  assert.deepEqual(loginForm(), {
    admissionEmail: "member@example.com",
    normalizedEmail: "member@example.com",
    password: validPassword,
    valid: true,
  });

  const oversizedPassword = "x".repeat(100_000);
  const oversized = loginForm("member@example.com", oversizedPassword);
  assert.equal(oversized.valid, false);
  assert.notEqual(oversized.password, oversizedPassword);
  assert.ok(oversized.password.length < 100);

  const extraField = new FormData();
  extraField.append("email", "member@example.com");
  extraField.append("password", validPassword);
  extraField.append("returnTo", "/admin");
  assert.equal(readMemberLoginForm(extraField).valid, false);

  const duplicateEmail = new FormData();
  duplicateEmail.append("email", "member@example.com");
  duplicateEmail.append("email", "other@example.com");
  duplicateEmail.append("password", validPassword);
  assert.equal(readMemberLoginForm(duplicateEmail).valid, false);

  const rawOversizedEmail = `${"a".repeat(1_281)}@example.com`;
  const oversizedEmail = loginForm(rawOversizedEmail);
  assert.equal(oversizedEmail.valid, false);
  assert.equal(oversizedEmail.normalizedEmail, null);
  assert.notEqual(oversizedEmail.admissionEmail, rawOversizedEmail);
});

test("an admitted valid credential creates a CAS-bound eight-hour session", async () => {
  const harness = createHarness();
  const result = await harness.login();

  assert.equal(result.authenticated, true);
  assert.deepEqual(harness.calls.findCredential, [
    [workspaceId, "member@example.com"],
  ]);
  assert.deepEqual(harness.calls.verifyPassword, [
    [validPassword, passwordVerifier],
  ]);
  assert.equal(harness.calls.createSession.length, 1);
  assert.deepEqual(harness.calls.createSession[0], {
    createdAt: new Date("2026-09-03T12:00:01.000Z"),
    expectedPassword: passwordVerifier,
    expiresAt: new Date("2026-09-03T20:00:01.000Z"),
    memberId,
    sessionId,
    workspaceId,
  });
  assert.equal(harness.calls.clearFailure.length, 1);
  assert.equal(harness.calls.recordFailure.length, 0);
  assert.deepEqual(harness.calls.startBrowserSession, [
    {
      createdAt: new Date("2026-09-03T12:00:01.000Z"),
      expiresAt: new Date("2026-09-03T20:00:01.000Z"),
      memberId,
      sessionId,
      workspaceId,
    },
  ]);

  const serializedReservation = JSON.stringify(harness.calls.reserve[0]);
  assert.doesNotMatch(serializedReservation, /member@example\.com/u);
  assert.doesNotMatch(serializedReservation, /192\.0\.2\.10/u);
});

test("every admitted unavailable identity path performs one dummy password check", async () => {
  const oversizedPassword = "x".repeat(100_000);
  const cases = [
    {
      form: loginForm(),
      name: "unknown member",
      options: { credential: null },
      expectedLookups: 1,
      expectedPassword: validPassword,
    },
    {
      form: loginForm(),
      name: "disabled member",
      options: { credential: activeCredential("disabled") },
      expectedLookups: 1,
      expectedPassword: validPassword,
    },
    {
      form: loginForm("member@example.com", "too short"),
      name: "malformed form",
      options: {},
      expectedLookups: 0,
      expectedPassword: "too short",
    },
    {
      form: loginForm("member@example.com", oversizedPassword),
      name: "oversized direct request",
      options: {},
      expectedLookups: 0,
      expectedPassword: null,
    },
    {
      form: loginForm(),
      name: "credential lookup failure",
      options: { credentialLookupError: true },
      expectedLookups: 1,
      expectedPassword: validPassword,
    },
  ] as const;

  for (const testCase of cases) {
    const harness = createHarness(testCase.options);
    const result = await harness.login(testCase.form);

    assert.deepEqual(
      result,
      { authenticated: false, cleanupFailed: false, reason: "credentials" },
      testCase.name,
    );
    assert.equal(harness.calls.findCredential.length, testCase.expectedLookups);
    assert.equal(harness.calls.verifyPassword.length, 1, testCase.name);
    assert.equal(harness.calls.verifyPassword[0]?.[1], null, testCase.name);
    if (testCase.expectedPassword === null) {
      assert.notEqual(
        harness.calls.verifyPassword[0]?.[0],
        oversizedPassword,
        testCase.name,
      );
    } else {
      assert.equal(
        harness.calls.verifyPassword[0]?.[0],
        testCase.expectedPassword,
        testCase.name,
      );
    }
    assert.equal(harness.calls.recordFailure.length, 1, testCase.name);
    assert.equal(harness.calls.createSession.length, 0, testCase.name);
    assert.equal(harness.calls.startBrowserSession.length, 0, testCase.name);
  }
});

test("wrong credentials and a stale verifier CAS both complete as generic failures", async () => {
  const wrongPassword = createHarness({ verifyResult: false });
  assert.deepEqual(await wrongPassword.login(), {
    authenticated: false,
    cleanupFailed: false,
    reason: "credentials",
  });
  assert.deepEqual(wrongPassword.calls.verifyPassword, [
    [validPassword, passwordVerifier],
  ]);
  assert.equal(wrongPassword.calls.recordFailure.length, 1);

  const staleVerifier = createHarness({ createSessionResult: false });
  assert.deepEqual(await staleVerifier.login(), {
    authenticated: false,
    cleanupFailed: false,
    reason: "credentials",
  });
  assert.equal(staleVerifier.calls.verifyPassword.length, 1);
  assert.equal(staleVerifier.calls.createSession.length, 1);
  assert.equal(staleVerifier.calls.recordFailure.length, 1);
  assert.equal(staleVerifier.calls.startBrowserSession.length, 0);
});

test("rejected admission performs no identity or password work", async () => {
  const harness = createHarness({
    reserveResult: {
      accepted: false,
      reason: "source",
      retryAfterAt: new Date("2026-09-03T12:10:00.000Z"),
    },
  });

  assert.deepEqual(await harness.login(), {
    authenticated: false,
    cleanupFailed: false,
    reason: "admission",
  });
  assert.equal(harness.calls.verifyPassword.length, 0);
  assert.equal(harness.calls.findCredential.length, 0);
  assert.equal(harness.calls.createSession.length, 0);
});

test("cookie delivery failure revokes the database session and reports failed cleanup", async () => {
  const cleaned = createHarness({ startBrowserSessionError: true });
  assert.deepEqual(await cleaned.login(), {
    authenticated: false,
    cleanupFailed: false,
    reason: "internal",
  });
  assert.equal(cleaned.calls.revokeSession.length, 1);

  const orphaned = createHarness({
    revokeSessionResult: false,
    startBrowserSessionError: true,
  });
  assert.deepEqual(await orphaned.login(), {
    authenticated: false,
    cleanupFailed: true,
    reason: "internal",
  });
  assert.equal(orphaned.calls.clearFailure.length, 1);
  assert.equal(orphaned.calls.revokeSession.length, 1);
});

test("runtime login has no environment credential or stateless-session fallback", () => {
  const loginAction = readFileSync(
    path.join(process.cwd(), "src/app/admin/login/actions.ts"),
    "utf8",
  );
  const adminRuntime = readFileSync(
    path.join(process.cwd(), "src/auth/admin.ts"),
    "utf8",
  );
  const sessionConfig = readFileSync(
    path.join(process.cwd(), "src/auth/config.ts"),
    "utf8",
  );
  const loginPage = readFileSync(
    path.join(process.cwd(), "src/app/admin/login/page.tsx"),
    "utf8",
  );
  const runtimeSource = `${loginAction}\n${adminRuntime}\n${sessionConfig}`;

  for (const forbidden of [
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "adminCredentialsMatch",
    "createAdminSessionToken",
    "getAdminConfig",
  ]) {
    assert.doesNotMatch(runtimeSource, new RegExp(forbidden, "u"), forbidden);
  }
  assert.match(loginAction, /readLoginSource\(request\)/u);
  assert.match(loginAction, /getLoginAdmissionRepository\(\)/u);
  assert.match(loginAction, /getMemberRepository\(\)/u);
  assert.match(loginAction, /Email or password is incorrect\./u);
  assert.equal(loginAction.match(/return failedLogin/gu)?.length, 2);
  assert.doesNotMatch(loginAction, /result\.reason|retryAfterAt/u);
  assert.doesNotMatch(loginPage, /configured credentials/iu);
  assert.match(loginPage, /OPAS team account/u);

  const loginForm = readFileSync(
    path.join(process.cwd(), "src/app/admin/login/form.tsx"),
    "utf8",
  );
  assert.match(loginForm, /maxLength=\{2048\}/u);
});
