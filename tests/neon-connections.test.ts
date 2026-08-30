// ABOUTME: Verifies that Neon pooled and direct URLs identify one complete database target.
// ABOUTME: Prevents deployment preparation from accepting an unpaired or incomplete direct URL.
import assert from "node:assert/strict";
import test from "node:test";

import {
  requireNeonConnectionStrings,
  requireNeonDirectConnectionString,
} from "../scripts/neon-connections";
import { neonPoolConfiguration } from "../scripts/prepare-neon";

const pooledUrl =
  "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas?sslmode=require";
const directUrl =
  "postgresql://opas:database-password@ep-demo.eu-central-1.aws.neon.tech/opas?sslmode=require";

test("derives a direct URL from the required pooled database identity", () => {
  assert.deepEqual(requireNeonConnectionStrings({ NEON_DATABASE_URL: pooledUrl }), {
    pooled: pooledUrl,
    direct: directUrl,
  });
});

test("returns an explicit direct URL only when it matches the pooled identity", () => {
  assert.equal(
    requireNeonDirectConnectionString({
      NEON_DATABASE_URL: pooledUrl,
      NEON_DIRECT_DATABASE_URL: directUrl,
    }),
    directUrl,
  );
});

test("requires the pooled URL even when an explicit direct URL exists", () => {
  assert.throws(
    () =>
      requireNeonDirectConnectionString({
        NEON_DIRECT_DATABASE_URL: directUrl,
      }),
    /NEON_DATABASE_URL/u,
  );
});

test("rejects incomplete pooled and direct URLs", () => {
  const incompletePooledUrls = [
    "postgresql://opas@ep-demo-pooler.eu-central-1.aws.neon.tech/opas",
    "postgresql://:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas",
    "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/",
  ];
  const incompleteDirectUrls = [
    "postgresql://opas@ep-demo.eu-central-1.aws.neon.tech/opas",
    "postgresql://:database-password@ep-demo.eu-central-1.aws.neon.tech/opas",
    "postgresql://opas:database-password@ep-demo.eu-central-1.aws.neon.tech/",
  ];

  for (const value of incompletePooledUrls) {
    assert.throws(() => requireNeonConnectionStrings({ NEON_DATABASE_URL: value }));
  }
  for (const value of incompleteDirectUrls) {
    assert.throws(() =>
      requireNeonConnectionStrings({
        NEON_DATABASE_URL: pooledUrl,
        NEON_DIRECT_DATABASE_URL: value,
      }),
    );
  }
});

test("rejects URLs whose hosts have the wrong connection role", () => {
  assert.throws(() =>
    requireNeonConnectionStrings({ NEON_DATABASE_URL: directUrl }),
  );
  assert.throws(() =>
    requireNeonConnectionStrings({
      NEON_DATABASE_URL: pooledUrl,
      NEON_DIRECT_DATABASE_URL: pooledUrl,
    }),
  );
});

test("rejects direct URLs with a different endpoint, port, credentials, or database", () => {
  const mismatches = [
    "postgresql://opas:database-password@ep-other.eu-central-1.aws.neon.tech/opas?sslmode=require",
    "postgresql://opas:database-password@ep-demo.eu-central-1.aws.neon.tech:6543/opas?sslmode=require",
    "postgresql://other:database-password@ep-demo.eu-central-1.aws.neon.tech/opas?sslmode=require",
    "postgresql://opas:other-database-password@ep-demo.eu-central-1.aws.neon.tech/opas?sslmode=require",
    "postgresql://opas:database-password@ep-demo.eu-central-1.aws.neon.tech/other?sslmode=require",
  ];

  for (const value of mismatches) {
    assert.throws(() =>
      requireNeonConnectionStrings({
        NEON_DATABASE_URL: pooledUrl,
        NEON_DIRECT_DATABASE_URL: value,
      }),
    );
  }
});

test("rejects non-Neon authorities even when pooled and direct names pair", () => {
  assert.throws(() =>
    requireNeonConnectionStrings({
      NEON_DATABASE_URL:
        "postgresql://opas:database-password@ep-demo-pooler.attacker.example/opas?sslmode=require",
      NEON_DIRECT_DATABASE_URL:
        "postgresql://opas:database-password@ep-demo.attacker.example/opas?sslmode=require",
    }),
  );
});

test("rejects query parameters that can override the parsed connection target", () => {
  const overrides = [
    "host=attacker.example",
    "port=6543",
    "user=attacker",
    "password=changed",
    "database=other",
    "dbname=other",
    "options=-csearch_path%3Dshadow",
    "sslmode=require&sslmode=disable",
  ];

  for (const parameter of overrides) {
    assert.throws(() =>
      requireNeonConnectionStrings({
        NEON_DATABASE_URL: pooledUrl,
        NEON_DIRECT_DATABASE_URL: `${directUrl}&${parameter}`,
      }),
    );
  }
});

test("requires TLS and rejects downgraded channel binding", () => {
  const insecureUrls = [
    "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas",
    "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas?sslmode=disable",
    "postgresql://opas:database-password@ep-demo-pooler.eu-central-1.aws.neon.tech/opas?sslmode=require&channel_binding=disable",
  ];

  for (const value of insecureUrls) {
    assert.throws(() =>
      requireNeonConnectionStrings({ NEON_DATABASE_URL: value }),
    );
  }
});

test("rejects ambient PostgreSQL and TLS settings before preparing Neon", () => {
  for (const name of [
    "NODE_EXTRA_CA_CERTS",
    "Node_Options",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "node_tls_reject_unauthorized",
    "OPENSSL_CONF",
    "PGOPTIONS",
    "PGPORT",
    "PGSSLMODE",
    "pgoptions",
    "pgport",
    "PgSslMode",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
  ]) {
    assert.throws(() =>
      requireNeonDirectConnectionString({
        NEON_DATABASE_URL: pooledUrl,
        [name]: "unsafe",
      }),
    );
  }
});

test("constructs the effective pool target without ambient URL parsing", () => {
  assert.deepEqual(neonPoolConfiguration(directUrl), {
    database: "opas",
    enableChannelBinding: true,
    host: "ep-demo.eu-central-1.aws.neon.tech",
    password: "database-password",
    port: 5432,
    ssl: { rejectUnauthorized: true },
    user: "opas",
  });
});
