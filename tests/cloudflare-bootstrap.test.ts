// ABOUTME: Verifies that Cloudflare bootstrap configuration cannot escape OPAS resources.
// ABOUTME: Guards the maintained custom domain, workers.dev fallback, and matching Worker/D1 targets.
import assert from "node:assert/strict";
import test from "node:test";

import { validateCloudflareConfig } from "../scripts/bootstrap-cloudflare";

function validConfig() {
  return {
    name: "opas-mvp",
    account_id: "f8801c7e8853a113a25f8b52fd9ceec1",
    workers_dev: true,
    routes: [
      {
        pattern: "demo.opas.dev",
        custom_domain: true,
      },
    ],
    services: [
      {
        binding: "WORKER_SELF_REFERENCE",
        service: "opas-mvp",
      },
    ],
    vars: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_SITE_URL: "https://demo.opas.dev",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "opas-mvp",
        database_id: "database-id",
        migrations_dir: "drizzle/sqlite",
      },
    ],
  };
}

function workersDevConfig() {
  const config = validConfig();

  return {
    name: config.name,
    account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    services: config.services,
    vars: {
      ...config.vars,
      OPAS_SITE_URL: "https://opas-mvp.example.workers.dev",
    },
    d1_databases: config.d1_databases,
  };
}

test("accepts the maintained custom domain with workers.dev fallback", () => {
  const target = validateCloudflareConfig(validConfig());

  assert.equal(target.workerName, "opas-mvp");
  assert.equal(target.databaseName, "opas-mvp");
  assert.equal(target.siteOrigin, "https://demo.opas.dev");
});

test("retains the scoped workers.dev-only bootstrap path", () => {
  const target = validateCloudflareConfig(workersDevConfig());

  assert.equal(target.siteOrigin, "https://opas-mvp.example.workers.dev");
});

test("rejects protected, unrelated, and cross-wired resources", () => {
  const cases = [
    Object.assign(validConfig(), { name: "opas-landing" }),
    Object.assign(validConfig(), { name: "customer-worker" }),
    Object.assign(validConfig(), { account_id: "another-account" }),
    Object.assign(validConfig(), { workers_dev: false }),
    Object.assign(validConfig(), {
      vars: {
        OPAS_DATABASE_DRIVER: "d1",
        OPAS_SITE_URL: "https://example.com",
      },
    }),
    Object.assign(validConfig(), {
      d1_databases: [
        {
          binding: "DB",
          database_name: "opas-another-database",
          database_id: "database-id",
          migrations_dir: "drizzle/sqlite",
        },
      ],
    }),
    Object.assign(validConfig(), {
      d1_databases: [
        {
          binding: "DB",
          database_name: "opas-mvp",
          database_id: "database-id",
          migrations_dir: "drizzle/another-directory",
        },
      ],
    }),
  ];

  for (const config of cases) {
    assert.throws(() => validateCloudflareConfig(config));
  }
});

test("rejects protected and unrelated custom routes", () => {
  const routes = [
    { pattern: "opas.dev", custom_domain: true },
    { pattern: "www.opas.dev", custom_domain: true },
    { pattern: "*.opas.dev", custom_domain: true },
    { pattern: "mvp.opas.dev", custom_domain: true },
    { pattern: "demo.opas.dev/*", custom_domain: false },
    {
      pattern: "demo.opas.dev",
      custom_domain: true,
      zone_name: "opas.dev",
    },
  ];

  for (const route of routes) {
    assert.throws(() =>
      validateCloudflareConfig(Object.assign(validConfig(), { routes: [route] })),
    );
  }

  assert.throws(() =>
    validateCloudflareConfig(
      Object.assign(validConfig(), {
        routes: [
          { pattern: "demo.opas.dev", custom_domain: true },
          { pattern: "another.opas.dev", custom_domain: true },
        ],
      }),
    ),
  );
  assert.throws(() =>
    validateCloudflareConfig(Object.assign(validConfig(), { route: "demo.opas.dev/*" })),
  );
});

test("limits the maintained custom domain to its exact account and Worker", () => {
  assert.throws(() =>
    validateCloudflareConfig(
      Object.assign(validConfig(), { account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    ),
  );
  assert.throws(() =>
    validateCloudflareConfig(Object.assign(validConfig(), { name: "opas-another-worker" })),
  );
});

test("rejects non-production origins and mismatched self references", () => {
  const httpConfig = validConfig();
  httpConfig.vars.OPAS_SITE_URL = "http://demo.opas.dev";
  assert.throws(() => validateCloudflareConfig(httpConfig), /HTTPS origin/);

  const selfReferenceConfig = validConfig();
  selfReferenceConfig.services[0].service = "opas-another-worker";
  assert.throws(
    () => validateCloudflareConfig(selfReferenceConfig),
    /WORKER_SELF_REFERENCE/,
  );
});
