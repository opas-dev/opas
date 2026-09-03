// ABOUTME: Verifies the named-member password, session, one-time-link, and login-digest contracts.
// ABOUTME: Locks deterministic Web Crypto values, strict claims, bounded clocks, and key separation.
import assert from "node:assert/strict";
import test from "node:test";

import { decodeJwt, SignJWT } from "jose";

import {
  createDatabaseSessionId,
  createDatabaseSessionToken,
  databaseSessionContract,
  databaseSessionCookieName,
  databaseSessionCookieOptions,
  verifyDatabaseSessionToken,
} from "@/auth/database-session";
import {
  createLoginAdmissionDigests,
  loginAdmissionLookupDays,
  loginAdmissionUtcDay,
} from "@/auth/login-admission-digests";
import {
  createMemberLinkAcceptanceToken,
  createMemberLinkBearer,
  digestMemberLinkBearer,
  memberLinkAcceptanceCookieName,
  memberLinkAcceptanceCookieOptions,
  memberLinkContract,
  verifyMemberLinkAcceptanceToken,
} from "@/auth/member-link-claims";
import {
  assertMemberPasswordPolicy,
  createMemberPasswordVerifier,
  MemberPasswordPolicyError,
  memberPasswordPolicy,
  verifyMemberPassword,
} from "@/auth/member-password";
import {
  authEncoder,
  deriveAuthenticationKey,
  encodeBase64Url,
} from "@/auth/security-encoding";

const sessionSecret = "test-session-secret-with-at-least-32-bytes";
const otherSessionSecret = "other-session-secret-with-at-least-32-bytes";
const deploymentId = "opas.dev";
const now = new Date("2026-09-03T12:00:00.000Z");

function fixedBytes(offset = 0) {
  return (length: number) =>
    Uint8Array.from({ length }, (_unused, index) => (index + offset) & 0xff);
}

function jwtSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

async function signRawJwt(payload: Uint8Array, key: CryptoKey): Promise<string> {
  const header = encodeBase64Url(authEncoder.encode('{"alg":"HS256","typ":"JWT"}'));
  const encodedPayload = encodeBase64Url(payload);
  const signedValue = `${header}.${encodedPayload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, authEncoder.encode(signedValue)),
  );

  return `${signedValue}.${encodeBase64Url(signature)}`;
}

test("member password policy counts Unicode code points without composition rules", () => {
  assert.equal(memberPasswordPolicy.minimumCodePoints, 15);
  assert.equal(memberPasswordPolicy.maximumCodePoints >= 128, true);
  assert.equal(memberPasswordPolicy.iterations, 600_000);

  assert.doesNotThrow(() => assertMemberPasswordPolicy("a".repeat(15)));
  assert.doesNotThrow(() => assertMemberPasswordPolicy("🔐".repeat(128)));
  assert.doesNotThrow(() => assertMemberPasswordPolicy(" ".repeat(15)));

  assert.throws(
    () => assertMemberPasswordPolicy(`${"a".repeat(13)}🔐`),
    (error: unknown) =>
      error instanceof MemberPasswordPolicyError && error.code === "PASSWORD_TOO_SHORT",
  );
  assert.throws(
    () => assertMemberPasswordPolicy("🔐".repeat(memberPasswordPolicy.maximumCodePoints + 1)),
    (error: unknown) =>
      error instanceof MemberPasswordPolicyError && error.code === "PASSWORD_TOO_LONG",
  );
  assert.throws(
    () => assertMemberPasswordPolicy(`${"a".repeat(15)}\ud800`),
    (error: unknown) =>
      error instanceof MemberPasswordPolicyError &&
      error.code === "PASSWORD_INVALID_UNICODE",
  );
});

test("password verifier pins PBKDF2-HMAC-SHA-256 storage fields and exact matching", async () => {
  const password = "Correct horse 🐴 battery staple";
  const verifier = await createMemberPasswordVerifier(password, fixedBytes());

  assert.deepEqual(verifier, {
    digest: "4S9oraFYj1VHYsEAzJv7I26Du_KI5JPSBFQWO9kIVI8",
    iterations: 600_000,
    salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  });
  assert.equal(await verifyMemberPassword(password, verifier), true);
  assert.equal(await verifyMemberPassword("Correct horse 🐎 battery staple", verifier), false);
});

test("password verifier uses independent salts and fails closed after bounded malformed input", async () => {
  const password = "one valid password phrase";
  const [first, second] = await Promise.all([
    createMemberPasswordVerifier(password),
    createMemberPasswordVerifier(password),
  ]);

  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.digest, second.digest);
  assert.equal(
    await verifyMemberPassword(password, {
      digest: "not-base64url!",
      iterations: 1,
      salt: "short",
    }),
    false,
  );
  assert.equal(
    await verifyMemberPassword(password, {
      ...first,
      salt: `${first.salt.slice(0, -1)}9`,
    }),
    false,
  );
  assert.equal(await verifyMemberPassword(password, { ...first, salt: `${first.salt}=` }), false);
  assert.equal(await verifyMemberPassword(password, null), false);
  assert.equal(
    await verifyMemberPassword("x".repeat(memberPasswordPolicy.maximumCodePoints + 1), first),
    false,
  );
});

test("database session token contains only revocable row identity and strict standard claims", async () => {
  const databaseExpiresAt = new Date(now.getTime() + 10 * 60 * 60 * 1000);
  const created = await createDatabaseSessionToken(
    {
      databaseExpiresAt,
      memberId: "member_editor",
      sessionId: "session_123",
      workspaceId: "workspace_demo",
    },
    sessionSecret,
    deploymentId,
    now,
  );
  const expectedExpiry = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  assert.deepEqual(created.claims, {
    expiresAt: expectedExpiry,
    issuedAt: now,
    memberId: "member_editor",
    sessionId: "session_123",
    workspaceId: "workspace_demo",
  });
  assert.deepEqual(Object.keys(decodeJwt(created.token)).sort(), [
    "aud",
    "exp",
    "iat",
    "iss",
    "sid",
    "sub",
    "wid",
  ]);
  assert.deepEqual(
    await verifyDatabaseSessionToken(
      created.token,
      sessionSecret,
      deploymentId,
      new Date(now.getTime() + 1_000),
    ),
    created.claims,
  );
  assert.equal(
    await verifyDatabaseSessionToken(created.token, sessionSecret, deploymentId, expectedExpiry),
    null,
  );
});

test("database session expiry never exceeds its database row and invalid claims fail closed", async () => {
  const databaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const { claims, token } = await createDatabaseSessionToken(
    {
      databaseExpiresAt,
      memberId: "member_admin",
      sessionId: "session_short",
      workspaceId: "workspace_demo",
    },
    sessionSecret,
    deploymentId,
    now,
  );

  assert.deepEqual(claims.expiresAt, databaseExpiresAt);
  assert.equal(
    await verifyDatabaseSessionToken(
      token,
      otherSessionSecret,
      deploymentId,
      new Date(now.getTime() + 1_000),
    ),
    null,
  );
  assert.equal(
    await verifyDatabaseSessionToken(
      token,
      sessionSecret,
      "cro.opas.dev",
      new Date(now.getTime() + 1_000),
    ),
    null,
  );

  const key = await deriveAuthenticationKey(
    sessionSecret,
    deploymentId,
    "database-session-v1",
  );
  const tokenWithRole = await new SignJWT({
    role: "administrator",
    sid: "session_short",
    wid: "workspace_demo",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(databaseSessionContract.issuer)
    .setAudience(databaseSessionContract.audience)
    .setSubject("member_admin")
    .setIssuedAt(jwtSeconds(now))
    .setExpirationTime(jwtSeconds(databaseExpiresAt))
    .sign(key);

  assert.equal(
    await verifyDatabaseSessionToken(
      tokenWithRole,
      sessionSecret,
      deploymentId,
      new Date(now.getTime() + 1_000),
    ),
    null,
  );
});

test("database session parser rejects padding, duplicate claims, unknown headers, and invalid UTF-8", async () => {
  const issuedAt = jwtSeconds(now);
  const expiresAt = issuedAt + databaseSessionContract.lifetimeSeconds;
  const key = await deriveAuthenticationKey(
    sessionSecret,
    deploymentId,
    "database-session-v1",
  );
  const duplicateIssuedAt = await signRawJwt(
    authEncoder.encode(
      `{"sid":"session_123","wid":"workspace_demo","iss":"opas","aud":"opas-admin-session","sub":"member_admin","iat":${issuedAt},"iat":${issuedAt},"exp":${expiresAt}}`,
    ),
    key,
  );
  const invalidUtf8 = await signRawJwt(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), key);
  const unknownHeader = await new SignJWT({ sid: "session_123", wid: "workspace_demo" })
    .setProtectedHeader({ alg: "HS256", kid: "unexpected", typ: "JWT" })
    .setIssuer(databaseSessionContract.issuer)
    .setAudience(databaseSessionContract.audience)
    .setSubject("member_admin")
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  const futureIssued = await new SignJWT({ sid: "session_123", wid: "workspace_demo" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(databaseSessionContract.issuer)
    .setAudience(databaseSessionContract.audience)
    .setSubject("member_admin")
    .setIssuedAt(issuedAt + 1)
    .setExpirationTime(expiresAt)
    .sign(key);
  const valid = await createDatabaseSessionToken(
    {
      databaseExpiresAt: new Date(expiresAt * 1000),
      memberId: "member_admin",
      sessionId: "session_123",
      workspaceId: "workspace_demo",
    },
    sessionSecret,
    deploymentId,
    now,
  );

  for (const token of [
    `${valid.token}=`,
    duplicateIssuedAt,
    invalidUtf8,
    unknownHeader,
    futureIssued,
  ]) {
    assert.equal(
      await verifyDatabaseSessionToken(token, sessionSecret, deploymentId, now),
      null,
    );
  }
});

test("database session IDs and cookies are random, deployment-scoped, and host-only", () => {
  assert.equal(
    createDatabaseSessionId(fixedBytes()),
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  );
  assert.equal(databaseSessionCookieName("opas.dev"), "opas_admin_session_b3Bhcy5kZXY");
  assert.notEqual(databaseSessionCookieName("opas.dev"), databaseSessionCookieName("cro.opas.dev"));
  assert.throws(() => databaseSessionCookieName("OPAS.DEV"), /INVALID_DEPLOYMENT_ID/);

  const expiresAt = new Date(now.getTime() + 60_000);
  const options = databaseSessionCookieOptions(expiresAt, now);
  assert.deepEqual(options, {
    expires: expiresAt,
    httpOnly: true,
    maxAge: 60,
    path: "/admin",
    priority: "high",
    sameSite: "lax",
    secure: true,
  });
  assert.equal("domain" in options, false);

  const bounded = databaseSessionCookieOptions(
    new Date(now.getTime() + 24 * 60 * 60 * 1000),
    now,
  );
  assert.equal(bounded.maxAge, databaseSessionContract.lifetimeSeconds);
  assert.deepEqual(
    bounded.expires,
    new Date(now.getTime() + databaseSessionContract.lifetimeSeconds * 1000),
  );
});

test("member links use 256-bit fragment bearers and store only their one-way digest", async () => {
  const bearer = createMemberLinkBearer(fixedBytes());

  assert.equal(bearer, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(
    await digestMemberLinkBearer(bearer),
    "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
  );
  assert.equal(await digestMemberLinkBearer(`${bearer}=`), null);
  assert.equal(await digestMemberLinkBearer(`${bearer.slice(0, -1)}9`), null);
  assert.equal(await digestMemberLinkBearer("not-a-256-bit-bearer"), null);
});

test("member-link acceptance claims are kind-specific and capped by database expiry", async () => {
  const databaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const created = await createMemberLinkAcceptanceToken(
    {
      databaseExpiresAt,
      kind: "invite",
      recordId: "invitation_123",
      workspaceId: "workspace_demo",
    },
    sessionSecret,
    deploymentId,
    now,
  );

  assert.deepEqual(created.claims, {
    expiresAt: databaseExpiresAt,
    issuedAt: now,
    kind: "invite",
    recordId: "invitation_123",
    workspaceId: "workspace_demo",
  });
  assert.deepEqual(Object.keys(decodeJwt(created.token)).sort(), [
    "aud",
    "exp",
    "iat",
    "iss",
    "jti",
    "kind",
    "wid",
  ]);
  assert.deepEqual(
    await verifyMemberLinkAcceptanceToken(
      created.token,
      sessionSecret,
      deploymentId,
      "invite",
      new Date(now.getTime() + 1_000),
    ),
    created.claims,
  );
  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      created.token,
      sessionSecret,
      deploymentId,
      "credential_reset",
      new Date(now.getTime() + 1_000),
    ),
    null,
  );
  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      created.token,
      sessionSecret,
      "cro.opas.dev",
      "invite",
      new Date(now.getTime() + 1_000),
    ),
    null,
  );
  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      created.token,
      sessionSecret,
      deploymentId,
      "invite",
      databaseExpiresAt,
    ),
    null,
  );
});

test("member-link verifier rejects wrong audiences and unexpected claims", async () => {
  const issuedAt = jwtSeconds(now);
  const key = await deriveAuthenticationKey(
    sessionSecret,
    deploymentId,
    "member-link-acceptance-v1\0invite",
  );
  const wrongAudience = await new SignJWT({ kind: "invite", wid: "workspace_demo" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(memberLinkContract.issuer)
    .setAudience("opas-member-credential-reset-acceptance")
    .setJti("invitation_123")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + memberLinkContract.acceptanceLifetimeSeconds)
    .sign(key);
  const unexpectedClaim = await new SignJWT({
    email: "private@example.test",
    kind: "invite",
    wid: "workspace_demo",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(memberLinkContract.issuer)
    .setAudience("opas-member-invitation-acceptance")
    .setJti("invitation_123")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + memberLinkContract.acceptanceLifetimeSeconds)
    .sign(key);
  const duplicateKind = await signRawJwt(
    authEncoder.encode(
      `{"kind":"invite","wid":"workspace_demo","iss":"opas","aud":"opas-member-invitation-acceptance","jti":"invitation_123","iat":${issuedAt},"kind":"invite","exp":${issuedAt + memberLinkContract.acceptanceLifetimeSeconds}}`,
    ),
    key,
  );
  const futureIssued = await new SignJWT({ kind: "invite", wid: "workspace_demo" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(memberLinkContract.issuer)
    .setAudience("opas-member-invitation-acceptance")
    .setJti("invitation_123")
    .setIssuedAt(issuedAt + 1)
    .setExpirationTime(issuedAt + memberLinkContract.acceptanceLifetimeSeconds)
    .sign(key);

  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      wrongAudience,
      sessionSecret,
      deploymentId,
      "invite",
      new Date(now.getTime() + 1_000),
    ),
    null,
  );
  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      unexpectedClaim,
      sessionSecret,
      deploymentId,
      "invite",
      new Date(now.getTime() + 1_000),
    ),
    null,
  );
  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      duplicateKind,
      sessionSecret,
      deploymentId,
      "invite",
      now,
    ),
    null,
  );
  assert.equal(
    await verifyMemberLinkAcceptanceToken(
      futureIssued,
      sessionSecret,
      deploymentId,
      "invite",
      now,
    ),
    null,
  );
});

test("member-link cookies are secure, host-only, route-scoped, and deployment-specific", () => {
  assert.equal(
    memberLinkAcceptanceCookieName("opas.dev", "invite"),
    "opas_member_invite_b3Bhcy5kZXY",
  );
  assert.notEqual(
    memberLinkAcceptanceCookieName("opas.dev", "invite"),
    memberLinkAcceptanceCookieName("opas.dev", "credential_reset"),
  );
  assert.notEqual(
    memberLinkAcceptanceCookieName("opas.dev", "invite"),
    memberLinkAcceptanceCookieName("cro.opas.dev", "invite"),
  );

  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const options = memberLinkAcceptanceCookieOptions(expiresAt, now);
  assert.deepEqual(options, {
    expires: expiresAt,
    httpOnly: true,
    maxAge: 900,
    path: "/admin/accept",
    priority: "high",
    sameSite: "lax",
    secure: true,
  });
  assert.equal("domain" in options, false);

  const bounded = memberLinkAcceptanceCookieOptions(
    new Date(now.getTime() + 24 * 60 * 60 * 1000),
    now,
  );
  assert.equal(bounded.maxAge, memberLinkContract.acceptanceLifetimeSeconds);
  assert.deepEqual(
    bounded.expires,
    new Date(now.getTime() + memberLinkContract.acceptanceLifetimeSeconds * 1000),
  );
});

test("daily login digests are deterministic, normalized, domain-separated, and opaque", async () => {
  const input = {
    canonicalSourceAddress: "2001:db8::1",
    day: "2026-09-03",
    deploymentId,
    sessionSecret,
    submittedEmail: "  Editor@OPAS.dev ",
    workspaceId: "workspace_demo",
  };
  const digests = await createLoginAdmissionDigests(input);

  assert.deepEqual(digests, {
    day: "2026-09-03",
    principal: "87e495ae86858448f3f60bde732ff237bd46ff921cfc02b162a656cce2f8f618",
    source: "4541429e34062ad88eb6e4c1402362a78f839bb1d8b69f187a4335dd60b676c5",
    sourcePrincipal: "b3707e93b559e21045344585db17920c794f557d6f553d2d2c29d1012f0c66b6",
    workspace: "1ff4dfc3910be85d80e7e877e8bd835660ab712de80c98f68976ed793d33eaa8",
  });
  assert.deepEqual(
    await createLoginAdmissionDigests({ ...input, submittedEmail: "editor@opas.dev" }),
    digests,
  );

  const serialized = JSON.stringify(digests);
  assert.doesNotMatch(serialized, /editor|opas\.dev|2001|db8/i);
  assert.equal(new Set(Object.values(digests).slice(1)).size, 4);
  for (const digest of Object.values(digests).slice(1)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});

test("login digests rotate daily and isolate source, principal, deployment, and secret", async () => {
  const input = {
    canonicalSourceAddress: "203.0.113.8",
    day: "2026-09-03",
    deploymentId,
    sessionSecret,
    submittedEmail: "editor@opas.dev",
    workspaceId: "workspace_demo",
  };
  const baseline = await createLoginAdmissionDigests(input);
  const nextDay = await createLoginAdmissionDigests({ ...input, day: "2026-09-04" });
  const otherSource = await createLoginAdmissionDigests({
    ...input,
    canonicalSourceAddress: "203.0.113.9",
  });
  const otherPrincipal = await createLoginAdmissionDigests({
    ...input,
    submittedEmail: "reviewer@opas.dev",
  });
  const otherDeployment = await createLoginAdmissionDigests({
    ...input,
    deploymentId: "cro.opas.dev",
  });
  const otherSecret = await createLoginAdmissionDigests({
    ...input,
    sessionSecret: otherSessionSecret,
  });

  assert.notEqual(nextDay.source, baseline.source);
  assert.notEqual(otherSource.source, baseline.source);
  assert.equal(otherSource.principal, baseline.principal);
  assert.notEqual(otherPrincipal.principal, baseline.principal);
  assert.equal(otherPrincipal.source, baseline.source);
  assert.notDeepEqual(otherDeployment, baseline);
  assert.notDeepEqual(otherSecret, baseline);
});

test("login admission exposes current and previous UTC days for midnight-spanning windows", async () => {
  assert.equal(loginAdmissionUtcDay(new Date("2026-09-03T00:00:00.000Z")), "2026-09-03");
  assert.deepEqual(loginAdmissionLookupDays(new Date("2026-09-03T00:00:00.000Z")), [
    "2026-09-03",
    "2026-09-02",
  ]);
  await assert.rejects(
    async () =>
      createLoginAdmissionDigests({
        canonicalSourceAddress: "not-an-address",
        day: "2026-02-30",
        deploymentId,
        sessionSecret,
        submittedEmail: "editor@opas.dev",
        workspaceId: "workspace_demo",
      }),
    /INVALID_LOGIN_ADMISSION_DAY/,
  );
});
