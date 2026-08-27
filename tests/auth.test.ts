// ABOUTME: Verifies administrator credential comparison and signed session behavior.
// ABOUTME: Guards expiry, payload minimization, and tamper rejection for the auth boundary.
import assert from "node:assert/strict";
import test from "node:test";

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";

import { authorizeAdminRoute } from "@/auth/admin-route";
import { adminCredentialsMatch } from "@/auth/credentials";
import {
  adminSessionCookie,
  adminSessionLifetimeSeconds,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "@/auth/session";
import { config as proxyConfig } from "@/proxy";

const sessionSecret = "test-session-secret-with-at-least-32-bytes";
const otherSessionSecret = "other-session-secret-with-at-least-32-bytes";
const issuedAt = new Date("2026-08-27T10:00:00.000Z");

test("administrator credentials require both normalized email and exact password", async () => {
  assert.equal(
    await adminCredentialsMatch(
      "  ADMIN@OPAS.DEV ",
      "correct horse battery staple",
      "admin@opas.dev",
      "correct horse battery staple",
    ),
    true,
  );
  assert.equal(
    await adminCredentialsMatch(
      "wrong@opas.dev",
      "correct horse battery staple",
      "admin@opas.dev",
      "correct horse battery staple",
    ),
    false,
  );
  assert.equal(
    await adminCredentialsMatch(
      "admin@opas.dev",
      "wrong",
      "admin@opas.dev",
      "correct horse battery staple",
    ),
    false,
  );
  assert.equal(
    await adminCredentialsMatch("", "", "admin@opas.dev", "correct horse battery staple"),
    false,
  );
});

test("signed sessions contain only fixed authorization claims and expire after eight hours", async () => {
  const { expiresAt, token } = await createAdminSessionToken(sessionSecret, issuedAt);
  const expectedExpiry = new Date(
    issuedAt.getTime() + adminSessionLifetimeSeconds * 1000,
  );

  assert.deepEqual(expiresAt, expectedExpiry);
  assert.deepEqual(
    await verifyAdminSessionToken(token, sessionSecret, new Date(issuedAt.getTime() + 1_000)),
    { expiresAt: expectedExpiry },
  );

  const [, encodedPayload] = token.split(".");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "iss", "sub"]);
  assert.equal(payload.sub, "admin");

  assert.equal(await verifyAdminSessionToken(token, sessionSecret, expectedExpiry), null);
});

test("signed sessions reject altered, malformed, and differently signed tokens", async () => {
  const { token } = await createAdminSessionToken(sessionSecret, issuedAt);
  const segments = token.split(".");
  const changedSignature = `${segments[2]?.startsWith("a") ? "b" : "a"}${segments[2]?.slice(1)}`;
  const alteredToken = [segments[0], segments[1], changedSignature].join(".");

  assert.equal(
    await verifyAdminSessionToken(token, otherSessionSecret, new Date(issuedAt.getTime() + 1_000)),
    null,
  );
  assert.equal(
    await verifyAdminSessionToken(alteredToken, sessionSecret, new Date(issuedAt.getTime() + 1_000)),
    null,
  );
  assert.equal(await verifyAdminSessionToken("not-a-token", sessionSecret, issuedAt), null);
  assert.equal(await verifyAdminSessionToken(undefined, sessionSecret, issuedAt), null);
});

test("Proxy matcher covers only administrator routes", () => {
  for (const url of ["/admin", "/admin/login", "/admin/theme", "/admin/content"]) {
    assert.equal(
      unstable_doesMiddlewareMatch({ config: proxyConfig, nextConfig: {}, url }),
      true,
      url,
    );
  }

  for (const url of ["/", "/spike", "/api/health"]) {
    assert.equal(
      unstable_doesMiddlewareMatch({ config: proxyConfig, nextConfig: {}, url }),
      false,
      url,
    );
  }
});

test("administrator route gate redirects missing and invalid sessions", async () => {
  const missingResponse = await authorizeAdminRoute(
    new NextRequest("https://docs.example.com/admin/theme"),
    sessionSecret,
  );
  assert.equal(missingResponse.headers.get("location"), "https://docs.example.com/admin/login");

  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnvironment = environment.NODE_ENV;
  environment.NODE_ENV = "production";

  try {
    const invalidRequest = new NextRequest("https://docs.example.com/admin/theme", {
      headers: { cookie: `${adminSessionCookie}=not-a-token` },
    });
    const invalidResponse = await authorizeAdminRoute(invalidRequest, sessionSecret);
    assert.equal(invalidResponse.headers.get("location"), "https://docs.example.com/admin/login");
    assert.match(invalidResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.match(invalidResponse.headers.get("set-cookie") ?? "", /Path=\/admin/);
    assert.match(invalidResponse.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(invalidResponse.headers.get("set-cookie") ?? "", /Secure/);
    assert.match(invalidResponse.headers.get("set-cookie") ?? "", /SameSite=lax/i);
  } finally {
    if (previousNodeEnvironment === undefined) {
      delete environment.NODE_ENV;
    } else {
      environment.NODE_ENV = previousNodeEnvironment;
    }
  }
});

test("administrator route gate passes protected requests and redirects login sessions", async () => {
  const { token } = await createAdminSessionToken(sessionSecret);
  const authenticatedHeaders = { cookie: `${adminSessionCookie}=${token}` };
  const protectedResponse = await authorizeAdminRoute(
    new NextRequest("https://docs.example.com/admin/theme", {
      headers: authenticatedHeaders,
    }),
    sessionSecret,
  );
  assert.equal(protectedResponse.headers.get("x-middleware-next"), "1");

  const loginResponse = await authorizeAdminRoute(
    new NextRequest("https://docs.example.com/admin/login", {
      headers: authenticatedHeaders,
    }),
    sessionSecret,
  );
  assert.equal(loginResponse.headers.get("location"), "https://docs.example.com/admin/content");
});
