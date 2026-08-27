// ABOUTME: Verifies that Cloudflare bootstrap configuration cannot escape OPAS resources.
// ABOUTME: Guards explicit accounts, workers.dev-only routes, and matching Worker/D1 targets.
import assert from "node:assert/strict";
import test from "node:test";

import { validateCloudflareConfig } from "../scripts/bootstrap-cloudflare";

function validConfig() {
  return {
    name: "opas-mvp",
    account_id: "f8801c7e8853a113a25f8b52fd9ceec1",
    services: [
      {
        binding: "WORKER_SELF_REFERENCE",
        service: "opas-mvp",
      },
    ],
    vars: {
      OPAS_DATABASE_DRIVER: "d1",
      OPAS_SITE_URL: "https://opas-mvp.example.workers.dev",
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

test("accepts one explicit workers.dev OPAS target", () => {
  const target = validateCloudflareConfig(validConfig());

  assert.equal(target.workerName, "opas-mvp");
  assert.equal(target.databaseName, "opas-mvp");
  assert.equal(target.siteOrigin, "https://opas-mvp.example.workers.dev");
});

test("rejects protected, unrelated, and cross-wired resources", () => {
  const cases = [
    Object.assign(validConfig(), { name: "opas-landing" }),
    Object.assign(validConfig(), { name: "customer-worker" }),
    Object.assign(validConfig(), { account_id: "another-account" }),
    Object.assign(validConfig(), { routes: ["opas.dev/*"] }),
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

test("rejects non-production origins and mismatched self references", () => {
  const httpConfig = validConfig();
  httpConfig.vars.OPAS_SITE_URL = "http://opas-mvp.example.workers.dev";
  assert.throws(() => validateCloudflareConfig(httpConfig), /HTTPS origin/);

  const selfReferenceConfig = validConfig();
  selfReferenceConfig.services[0].service = "opas-another-worker";
  assert.throws(
    () => validateCloudflareConfig(selfReferenceConfig),
    /WORKER_SELF_REFERENCE/,
  );
});
