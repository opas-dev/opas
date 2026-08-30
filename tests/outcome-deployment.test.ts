// ABOUTME: Verifies portable privacy retention and cleanup wiring across deployment targets.
// ABOUTME: Guards independent schedules, bounded routes, env contracts, and additive migrations.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleAnalyticsCleanupRequest } from "@/outcomes/cleanup-route";

function source(path: string) {
  return readFileSync(path, "utf8");
}

function jsonFile(path: string) {
  const value = source(path);
  return JSON.parse(value.slice(value.indexOf("{"))) as Record<string, unknown>;
}

test("Cloudflare separates minute recovery from daily privacy cleanup", () => {
  const config = jsonFile("wrangler.jsonc");
  assert.deepEqual(config.triggers, { crons: ["* * * * *", "15 0 * * *"] });
  const vars = config.vars as Record<string, unknown>;
  assert.equal(vars.OPAS_ANSWER_ANALYTICS_RETENTION_DAYS, "30");
  assert.equal(vars.OPAS_ANALYTICS_REDACTION_PATTERNS, "[]");
  assert.equal(vars.OPAS_HANDOFF_DAILY_LIMIT, "100");
  assert.equal(vars.OPAS_HANDOFF_RETENTION_DAYS, "30");
  assert.match(String(config.compatibility_flags), /global_fetch_strictly_public/u);

  const worker = source("custom-worker.ts");
  const embedding = worker.indexOf('controller.cron === "* * * * *"');
  const analytics = worker.indexOf('controller.cron === "15 0 * * *"');
  assert.ok(embedding >= 0 && analytics > embedding);
  assert.match(worker, /createSqliteConversationAnalyticsStore/u);
  assert.match(worker, /createSqlitePublicWriteAdmissionStore/u);
  assert.match(worker, /createSqliteSupportHandoffStore/u);
  assert.match(worker, /Scheduled analytics cleanup failed\./u);
  assert.doesNotMatch(
    worker.slice(embedding, analytics),
    /runConfiguredAnalyticsCleanup/u,
  );
});

test("Vercel and Docker run authenticated cleanup often enough to drain daily bounds", () => {
  const vercel = jsonFile("vercel.json");
  assert.deepEqual(vercel.crons, [
    { path: "/api/internal/embeddings", schedule: "0 0 * * *" },
    { path: "/api/internal/analytics", schedule: "15 0 * * *" },
  ]);
  const compose = source("docker-compose.yml");
  const dockerfile = source("Dockerfile");
  assert.match(compose, /analytics-cleanup:/u);
  assert.match(compose, /run-analytics-cleanup\.mjs/u);
  assert.match(compose, /OPAS_ANALYTICS_CLEANUP_INTERVAL_MS:\s*\$\{[^}]+:-21600000\}/u);
  assert.match(compose, /CRON_SECRET:\s*\$\{CRON_SECRET:\?Set CRON_SECRET in \.env\}/u);
  for (const name of [
    "OPAS_ANSWER_ANALYTICS_RETENTION_DAYS",
    "OPAS_ANALYTICS_REDACTION_PATTERNS",
    "OPAS_HANDOFF_DAILY_LIMIT",
    "OPAS_HANDOFF_RETENTION_DAYS",
  ]) {
    assert.match(compose, new RegExp(`${name}:\\s*\\$\\{${name}:`, "u"));
    assert.match(source(".env.example"), new RegExp(`^${name}=`, "mu"));
  }
  assert.match(dockerfile, /scripts\/run-analytics-cleanup\.mjs/u);
  assert.match(source("src/outcomes/runtime.ts"), /maximumCleanupBatches = 32/u);
  assert.match(source("src/outcomes/runtime.ts"), /cleanupLimit = 1_000/u);
});

test("private cleanup is authenticated, bounded, and exposes only deletion counts", async () => {
  const secret = "s".repeat(32);
  let calls = 0;
  const unauthorized = await handleAnalyticsCleanupRequest(
    new Request("https://help.example.test/api/internal/analytics"),
    { configuredSecret: secret, cleanup: async () => {
      calls += 1;
      return { batches: 1, conversations: 0, handoffs: 0, publicWrites: 0 };
    } },
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 0);

  const authorized = await handleAnalyticsCleanupRequest(
    new Request("https://help.example.test/api/internal/analytics", {
      headers: { authorization: `Bearer ${secret}` },
    }),
    {
      configuredSecret: secret,
      cleanup: async () => {
        calls += 1;
        return { batches: 2, conversations: 2_024, handoffs: 7, publicWrites: 3 };
      },
    },
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), {
    batches: 2,
    conversations: 2_024,
    handoffs: 7,
    publicWrites: 3,
  });
  assert.equal(authorized.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
});

test("routes reserve enough wall time while delivery remains below the platform ceiling", () => {
  for (const route of [
    "src/app/api/answers/route.ts",
    "src/app/api/handoff/route.ts",
    "src/app/api/internal/analytics/route.ts",
    "src/app/api/internal/embeddings/route.ts",
  ]) {
    assert.match(source(route), /export const maxDuration = 60/u, route);
  }
  assert.match(
    source("src/handoff/service.ts"),
    /handoffDeliveryTimeoutMilliseconds = 45_000/u,
  );
});

test("0007 adds only bounded analytics and public-write tables with no requester metadata", () => {
  for (const migration of [
    "drizzle/postgres/0007_wise_onslaught.sql",
    "drizzle/sqlite/0007_nostalgic_hulk.sql",
  ]) {
    const sql = source(migration);
    assert.match(sql, /conversation_analytics/u);
    assert.match(sql, /workspace_public_write_states/u);
    assert.match(sql, /public_write_reservations/u);
    assert.match(sql, /expires_at/u);
    assert.doesNotMatch(sql, /requester|user_agent|cookie|contact|email|phone/u);
  }
});

test("0008 adds nullable bounded first-content-token latency without inventing old values", () => {
  const postgres = source("drizzle/postgres/0008_brainy_crusher_hogan.sql");
  const sqlite = source("drizzle/sqlite/0008_lush_kid_colt.sql");
  for (const migration of [postgres, sqlite]) {
    assert.match(migration, /first_token_milliseconds/u);
    assert.match(
      migration,
      /first_token_milliseconds[^;]+between 0 and[^;]+duration_milliseconds/u,
    );
    assert.doesNotMatch(
      migration,
      /requester|user_agent|cookie|contact|email|phone/u,
    );
  }
  assert.match(
    sqlite,
    /SELECT "id", "workspace_id"[^;]+"duration_milliseconds", NULL, "input_tokens"/u,
  );
});
