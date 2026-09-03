// ABOUTME: Verifies login admission trusts only deployment-owned client-address headers.
// ABOUTME: Covers canonical IP parsing and fail-closed production behavior.
import assert from "node:assert/strict";
import test from "node:test";

import {
  dockerLoginSourceHeader,
  LoginSourceError,
  readLoginSource,
} from "@/auth/login-source";

function request(headers: Record<string, string>) {
  return new Request("https://help.example.test/admin/login", { headers });
}

test("Cloudflare trusts only one valid CF-Connecting-IP value", () => {
  const environment = { NODE_ENV: "production", OPAS_DATABASE_DRIVER: "d1" };
  assert.equal(
    readLoginSource(
      request({
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-for": "198.51.100.1",
      }),
      environment,
    ),
    "203.0.113.42",
  );
  assert.throws(
    () => readLoginSource(request({ "x-forwarded-for": "203.0.113.42" }), environment),
    LoginSourceError,
  );
});

test("Vercel ignores ordinary forwarded headers and rejects address lists", () => {
  const environment = { NODE_ENV: "production", OPAS_DATABASE_DRIVER: "neon" };
  assert.equal(
    readLoginSource(
      request({ "x-vercel-forwarded-for": "2001:0DB8:0:0:0:0:0:1" }),
      environment,
    ),
    "2001:db8::1",
  );
  assert.throws(
    () =>
      readLoginSource(
        request({
          "x-forwarded-for": "203.0.113.42",
          "x-vercel-forwarded-for": "203.0.113.42, 198.51.100.1",
        }),
        environment,
      ),
    LoginSourceError,
  );
});

test("production Postgres accepts only the private proxy header", () => {
  const environment = { NODE_ENV: "production", OPAS_DATABASE_DRIVER: "postgres" };
  assert.equal(
    readLoginSource(request({ [dockerLoginSourceHeader]: "198.51.100.24" }), environment),
    "198.51.100.24",
  );
  assert.throws(
    () => readLoginSource(request({ "x-forwarded-for": "198.51.100.24" }), environment),
    LoginSourceError,
  );
});

test("malformed production identity fails without echoing the submitted value", () => {
  const submitted = "private-address-value";
  assert.throws(
    () =>
      readLoginSource(request({ "cf-connecting-ip": submitted }), {
        NODE_ENV: "production",
        OPAS_DATABASE_DRIVER: "d1",
      }),
    (error: unknown) =>
      error instanceof LoginSourceError && !error.message.includes(submitted),
  );
});

test("local Postgres development uses one canonical loopback source", () => {
  assert.equal(
    readLoginSource(request({}), {
      NODE_ENV: "development",
      OPAS_DATABASE_DRIVER: "postgres",
    }),
    "127.0.0.1",
  );
  assert.equal(
    readLoginSource(request({}), { NODE_ENV: "test" }),
    "127.0.0.1",
  );
});
