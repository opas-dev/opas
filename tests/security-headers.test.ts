// ABOUTME: Verifies that every route receives the intended browser security headers.
// ABOUTME: Locks the narrowly required MDX allowances and the remaining CSP restrictions.
import assert from "node:assert/strict";
import test from "node:test";

import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";

import nextConfig from "../next.config";
import { contentSecurityPolicy } from "../src/security/headers";

test("applies shared security headers everywhere and one global CSP outside embed", async () => {
  const createHeaders = nextConfig.headers;
  if (!createHeaders) {
    assert.fail("Next.js must define the all-route header rule");
  }

  const rules = await createHeaders();
  const globalRule = rules.find((rule) => rule.source === "/:path*");

  assert.ok(globalRule);
  const values = Object.fromEntries(
    globalRule.headers.map((header) => [header.key, header.value]),
  );

  assert.equal(values["Content-Security-Policy"], undefined);
  assert.equal(
    values["Permissions-Policy"],
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  assert.equal(values["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(values["X-Content-Type-Options"], "nosniff");

  for (const path of ["/", "/help", "/admin/login", "/api/health"]) {
    const response = await unstable_getResponseFromNextConfig({
      nextConfig,
      url: `https://help.example.test${path}`,
    });
    assert.equal(
      response.headers.get("content-security-policy"),
      contentSecurityPolicy,
      path,
    );
    assert.equal(
      response.headers.get("x-content-type-options"),
      "nosniff",
      path,
    );
  }

  const embedResponse = await unstable_getResponseFromNextConfig({
    nextConfig,
    url: "https://help.example.test/embed?parentOrigin=https://docs.example.test",
  });
  assert.equal(embedResponse.headers.get("content-security-policy"), null);
  assert.equal(embedResponse.headers.get("x-content-type-options"), "nosniff");
});

test("limits CSP sources while allowing the two runtime MDX requirements", () => {
  const directives = new Map(
    contentSecurityPolicy.split("; ").map((directive) => {
      const [name, ...sources] = directive.split(" ");
      return [name, sources] as const;
    }),
  );

  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  assert.deepEqual(directives.get("script-src"), [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
  ]);
  assert.deepEqual(directives.get("style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
  assert.deepEqual(directives.get("object-src"), ["'none'"]);
  assert.deepEqual(directives.get("base-uri"), ["'self'"]);
  assert.deepEqual(directives.get("form-action"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
});
