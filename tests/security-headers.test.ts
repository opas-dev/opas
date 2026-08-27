// ABOUTME: Verifies that every route receives the intended browser security headers.
// ABOUTME: Locks the narrowly required MDX allowances and the remaining CSP restrictions.
import assert from "node:assert/strict";
import test from "node:test";

import nextConfig from "../next.config";
import { contentSecurityPolicy } from "../src/security/headers";

test("applies browser security headers to every route", async () => {
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

  assert.equal(values["Content-Security-Policy"], contentSecurityPolicy);
  assert.equal(
    values["Permissions-Policy"],
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  assert.equal(values["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(values["X-Content-Type-Options"], "nosniff");
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
