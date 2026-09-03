// ABOUTME: Verifies optimistic named-member routing at the administrator boundary.
// ABOUTME: Guards public entry paths and signed database-session cookie handling.
import assert from "node:assert/strict";
import test from "node:test";

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";

import { authorizeAdminRoute } from "@/auth/admin-route";
import {
  createDatabaseSessionToken,
  databaseSessionCookieName,
} from "@/auth/database-session";
import { config as proxyConfig } from "@/proxy";

const sessionSecret = "test-session-secret-with-at-least-32-bytes";
const deploymentId = "docs.example.com";
const workspaceId = "workspace_demo";

async function databaseSessionToken(signingSecret = sessionSecret) {
  const now = new Date();
  return createDatabaseSessionToken(
    {
      databaseExpiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1_000),
      memberId: "member_1",
      sessionId: "S".repeat(43),
      workspaceId,
    },
    signingSecret,
    deploymentId,
    now,
  );
}

test("Proxy matcher covers administrator routes and the dedicated embed document", () => {
  for (const url of [
    "/admin",
    "/admin/login",
    "/admin/login/",
    "/admin/accept",
    "/admin/accept/invite",
    "/admin/theme",
    "/admin/content",
  ]) {
    assert.equal(
      unstable_doesMiddlewareMatch({ config: proxyConfig, nextConfig: {}, url }),
      true,
      url,
    );
  }

  for (const url of ["/embed", "/embed?parentOrigin=https%3A%2F%2Fdocs.example.test"]) {
    assert.equal(
      unstable_doesMiddlewareMatch({ config: proxyConfig, nextConfig: {}, url }),
      true,
      url,
    );
  }

  for (const url of ["/", "/spike", "/embed.js", "/embed-child", "/api/health"]) {
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
    deploymentId,
  );
  assert.equal(missingResponse.headers.get("location"), "https://docs.example.com/admin/login");

  const cookieName = databaseSessionCookieName(deploymentId);
  const invalidRequest = new NextRequest("https://docs.example.com/admin/theme", {
    headers: { cookie: `${cookieName}=not-a-token` },
  });
  const invalidResponse = await authorizeAdminRoute(
    invalidRequest,
    sessionSecret,
    deploymentId,
  );
  assert.equal(invalidResponse.headers.get("location"), "https://docs.example.com/admin/login");
  assert.match(invalidResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.match(invalidResponse.headers.get("set-cookie") ?? "", /Path=\/admin/);
  assert.match(invalidResponse.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(invalidResponse.headers.get("set-cookie") ?? "", /Secure/);
  assert.match(invalidResponse.headers.get("set-cookie") ?? "", /SameSite=lax/i);
});

test("administrator route gate optimistically passes signed protected requests", async () => {
  const { token } = await databaseSessionToken();
  const authenticatedHeaders = {
    cookie: `${databaseSessionCookieName(deploymentId)}=${token}`,
  };
  const protectedResponse = await authorizeAdminRoute(
    new NextRequest("https://docs.example.com/admin/theme", {
      headers: authenticatedHeaders,
    }),
    sessionSecret,
    deploymentId,
  );
  assert.equal(protectedResponse.headers.get("x-middleware-next"), "1");
});

test("administrator route gate always permits login and acceptance paths", async () => {
  const { token } = await databaseSessionToken();
  const signedCookie = `${databaseSessionCookieName(deploymentId)}=${token}`;

  for (const path of [
    "/admin/login",
    "/admin/login/",
    "/admin/accept",
    "/admin/accept/invite",
    "/admin/accept/reset/details",
  ]) {
    for (const cookie of [signedCookie, `${databaseSessionCookieName(deploymentId)}=invalid`]) {
      const response = await authorizeAdminRoute(
        new NextRequest(`https://docs.example.com${path}`, {
          headers: { cookie },
        }),
        sessionSecret,
        deploymentId,
      );
      assert.equal(response.headers.get("x-middleware-next"), "1", path);
      assert.equal(response.headers.get("location"), null, path);
    }
  }
});
