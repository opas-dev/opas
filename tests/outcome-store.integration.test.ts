// ABOUTME: Runs analytics, public-write, and handoff-retention contracts on every SQL path.
// ABOUTME: Verifies atomic races, monotonic outcomes, expiry filtering, and physical deletion.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import Database from "better-sqlite3";
import { drizzle as createSqliteDatabase } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as createD1Database } from "drizzle-orm/d1";
import type { AnyD1Database } from "drizzle-orm/d1";
import { drizzle as createPostgresDatabase } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { createPostgresConversationAnalyticsStore } from "@/db/postgres/conversation-analytics-store";
import { createPostgresPublicWriteAdmissionStore } from "@/db/postgres/public-write-admission-store";
import { createPostgresSupportHandoffStore } from "@/db/postgres/support-handoff-store";
import * as postgresSchema from "@/db/schema/postgres";
import * as sqliteSchema from "@/db/schema/sqlite";
import { createSqliteConversationAnalyticsStore } from "@/db/sqlite/conversation-analytics-store";
import { createSqlitePublicWriteAdmissionStore } from "@/db/sqlite/public-write-admission-store";
import { createSqliteSupportHandoffStore } from "@/db/sqlite/support-handoff-store";
import type { HandoffStorageRecord, HandoffStore } from "@/handoff/service";
import {
  createHandoffWriteAdmission,
  createOutcomeWriteAdmission,
  maximumOutcomeWritesPerWindow,
  type PublicWriteAdmissionStore,
} from "@/outcomes/admission";
import {
  conversationStreamActiveReason,
  createConversationAnalyticsPolicy,
  prepareConversationAnalyticsRecord,
  type ConversationAnalyticsRecord,
  type ConversationOutcome,
} from "@/outcomes/records";
import type {
  ConversationAnalyticsStore,
} from "@/outcomes/store";

const workspaceId = "workspace_demo";
const current = new Date("2026-08-30T12:00:00.000Z");
const id = "123e4567-e89b-42d3-a456-426614174000";

function analyticsRecord(
  recordId: string,
  outcome: ConversationOutcome,
  overrides: Partial<ConversationAnalyticsRecord> = {},
) {
  const policy = createConversationAnalyticsPolicy({});
  if (policy.status !== "enabled") throw new Error("Expected analytics policy");
  const record = prepareConversationAnalyticsRecord(
    {
      conversation: [
        { content: "Email reader@example.com, password=x", role: "user" },
        { content: "Use the published settings page.", role: "assistant" },
      ],
      costMicrodollars: 7,
      durationMilliseconds: 500,
      firstTokenMilliseconds: outcome === "abstained" ? null : 275,
      id: recordId,
      inputTokens: 20,
      model: "fixture-model",
      outcome,
      outputTokens: 10,
      provider: "openai-compatible",
      reason: `${outcome}-reason`,
      retrievalTrace: [
        {
          articleContentHash: "a".repeat(64),
          articleId: "article_password",
          canonicalUrl: "https://help.example.com/account/reset-password",
          contentHash: "b".repeat(64),
          excerpt: "Reset password for reader@company from account settings.",
          headingPath: ["Account", "Reset password"],
          indexGeneration: 3,
          mode: "hybrid",
          ordinal: 0,
          score: 0.91,
          sourceId: "chunk_password",
          sourceLineRange: { end: 9, start: 4 },
          title: "Reset your password",
        },
      ],
      startedAt: new Date("2026-08-30T11:59:59.500Z"),
      updatedAt: current,
      workspaceId,
    },
    policy,
  );
  if (!record) throw new Error("Expected analytics record");
  return Object.freeze({ ...record, ...overrides });
}

function escapeHeavyAnalyticsRecord(recordId: string) {
  const policy = createConversationAnalyticsPolicy({});
  if (policy.status !== "enabled") throw new Error("Expected analytics policy");
  const record = prepareConversationAnalyticsRecord(
    {
      conversation: Array.from({ length: 10 }, (_, index) => ({
        content: `${index} ${"\\".repeat(4_000)}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      })),
      costMicrodollars: 7,
      durationMilliseconds: 500,
      firstTokenMilliseconds: 275,
      id: recordId,
      inputTokens: 20,
      model: "fixture-model",
      outcome: "answered",
      outputTokens: 10,
      provider: "openai-compatible",
      reason: "stop",
      retrievalTrace: Array.from({ length: 5 }, (_, index) => ({
        articleContentHash: "a".repeat(64),
        articleId: `article-${index}`,
        canonicalUrl: `https://help.example.com/article-${index}`,
        contentHash: "b".repeat(64),
        excerpt: "\\".repeat(4_000),
        headingPath: ["\\".repeat(1_000)],
        indexGeneration: 3,
        mode: "hybrid" as const,
        ordinal: index,
        score: index === 0 ? 1e-7 : 0.91,
        sourceId: `source-${index}`,
        sourceLineRange: { end: 9, start: 4 },
        title: "\\".repeat(2_000),
      })),
      startedAt: new Date("2026-08-30T11:59:59.500Z"),
      updatedAt: current,
      workspaceId,
    },
    policy,
  );
  if (!record) throw new Error("Expected escape-heavy analytics record");
  return record;
}

function scope(readAt = current, retentionStartedAt = new Date("2026-07-31T12:00:00.000Z")) {
  return Object.freeze({ readAt, retentionStartedAt });
}

function reservationId(index: number) {
  return `${index.toString(16).padStart(8, "0")}-e89b-42d3-a456-426614174000`;
}

function handoffRecord(recordId: string, createdAt: Date): HandoffStorageRecord {
  return Object.freeze({
    contact: Object.freeze({ email: "reader@example.com" }),
    context: Object.freeze({
      citations: Object.freeze([]),
      outcome: "abstained" as const,
      pageUrl: "https://customer.example.com/account",
      question: "How do I reset my password?",
      transcript: Object.freeze([
        Object.freeze({ content: "Question", role: "user" as const }),
      ]),
    }),
    createdAt,
    id: recordId,
    payloadHash: "a".repeat(64),
    status: "pending" as const,
    workspaceId,
  });
}

type StoreSet = Readonly<{
  analytics: ConversationAnalyticsStore;
  corruptAnalyticsTrace(id: string): Promise<void>;
  handoffs: HandoffStore;
  publicWrites: PublicWriteAdmissionStore;
  secondaryPublicWrites: PublicWriteAdmissionStore;
  rawAnalyticsCount(): Promise<number>;
  rawHandoffCount(): Promise<number>;
  rawOutcomeWindow(): Promise<
    Readonly<{ windowStartedAt: number; writeCount: number }> | null
  >;
  rawPublicWriteCount(): Promise<number>;
}>;

async function exerciseStores(name: string, stores: StoreSet) {
  assert.equal(
    await stores.analytics.put(
      analyticsRecord(id, "abandoned", {
        reason: conversationStreamActiveReason,
      }),
    ),
    true,
  );
  assert.equal(await stores.analytics.put(analyticsRecord(id, "answered")), true);
  assert.equal(
    (await stores.analytics.get(workspaceId, id, scope()))?.outcome,
    "answered",
    `${name} kept a completed stream provisional`,
  );

  const escapedId = "123e456d-e89b-42d3-a456-426614174000";
  const escaped = escapeHeavyAnalyticsRecord(escapedId);
  assert.equal(escaped.retrievalTrace[0]?.score, 0);
  assert.equal(await stores.analytics.put(escaped), true);
  const escapedRoundTrip = await stores.analytics.get(
    workspaceId,
    escapedId,
    scope(),
  );
  assert.deepEqual(escapedRoundTrip?.conversation, escaped.conversation);
  assert.deepEqual(escapedRoundTrip?.retrievalTrace, escaped.retrievalTrace);

  const concurrentAnsweredId = "123e4569-e89b-42d3-a456-426614174000";
  const answeredConflictAt = new Date("2026-08-30T12:00:01.000Z");
  const provisionalAnswer = analyticsRecord(concurrentAnsweredId, "abandoned", {
    conversation: [{ content: "active answer", role: "user" }],
    costMicrodollars: null,
    durationMilliseconds: 125,
    firstTokenMilliseconds: null,
    inputTokens: null,
    model: "active-model",
    outputTokens: null,
    provider: "active-provider",
    reason: conversationStreamActiveReason,
    retrievalTrace: [],
    updatedAt: answeredConflictAt,
  });
  const concurrentAnswer = analyticsRecord(concurrentAnsweredId, "answered", {
    conversation: [{ content: "completed answer", role: "assistant" }],
    model: "completed-model",
    updatedAt: answeredConflictAt,
  });
  assert.equal(await stores.analytics.put(provisionalAnswer), true);
  assert.equal(await stores.analytics.put(concurrentAnswer), true);
  const answeredRace = await stores.analytics.get(
    workspaceId,
    concurrentAnsweredId,
    scope(),
  );
  assert.equal(answeredRace?.outcome, "answered");
  assert.equal(answeredRace?.reason, "answered-reason");
  assert.equal(answeredRace?.model, "completed-model");
  assert.equal(answeredRace?.provider, "openai-compatible");
  assert.equal(answeredRace?.durationMilliseconds, 500);
  assert.equal(answeredRace?.firstTokenMilliseconds, 275);
  assert.equal(answeredRace?.inputTokens, 20);
  assert.equal(answeredRace?.outputTokens, 10);
  assert.equal(answeredRace?.costMicrodollars, 7);
  assert.equal(answeredRace?.retrievalTrace.length, 1);
  assert.deepEqual(answeredRace?.conversation, [
    { content: "completed answer", role: "assistant" },
  ]);

  const concurrentAbstainedId = "123e456a-e89b-42d3-a456-426614174000";
  const abstainedConflictAt = new Date("2026-08-30T12:00:03.000Z");
  const provisionalAbstention = analyticsRecord(
    concurrentAbstainedId,
    "abandoned",
    {
      conversation: [{ content: "active abstention", role: "user" }],
      costMicrodollars: null,
      durationMilliseconds: 125,
      firstTokenMilliseconds: null,
      inputTokens: null,
      model: "active-model",
      outputTokens: null,
      provider: "active-provider",
      reason: conversationStreamActiveReason,
      retrievalTrace: [],
      updatedAt: abstainedConflictAt,
    },
  );
  const concurrentAbstention = analyticsRecord(
    concurrentAbstainedId,
    "abstained",
    {
      conversation: [{ content: "completed abstention", role: "assistant" }],
      model: "completed-model",
      updatedAt: abstainedConflictAt,
    },
  );
  assert.equal(await stores.analytics.put(concurrentAbstention), true);
  assert.equal(await stores.analytics.put(provisionalAbstention), true);
  const abstainedRace = await stores.analytics.get(
    workspaceId,
    concurrentAbstainedId,
    scope(),
  );
  assert.equal(abstainedRace?.outcome, "abstained");
  assert.equal(abstainedRace?.reason, "abstained-reason");
  assert.equal(abstainedRace?.model, "completed-model");
  assert.equal(abstainedRace?.provider, "openai-compatible");
  assert.equal(abstainedRace?.durationMilliseconds, 500);
  assert.equal(abstainedRace?.firstTokenMilliseconds, null);
  assert.equal(abstainedRace?.inputTokens, 20);
  assert.equal(abstainedRace?.outputTokens, 10);
  assert.equal(abstainedRace?.costMicrodollars, 7);
  assert.equal(abstainedRace?.retrievalTrace.length, 1);
  assert.deepEqual(abstainedRace?.conversation, [
    { content: "completed abstention", role: "assistant" },
  ]);

  const abandonedId = "123e4568-e89b-42d3-a456-426614174000";
  assert.equal(
    await stores.analytics.put(
      analyticsRecord(abandonedId, "abandoned", {
        reason: conversationStreamActiveReason,
      }),
    ),
    true,
  );
  assert.equal(
    await stores.analytics.updateOutcome({
      id: abandonedId,
      outcome: "abandoned",
      reason: "user-cancelled",
      scope: scope(),
      updatedAt: new Date("2026-08-30T12:00:01.000Z"),
      workspaceId,
    }),
    true,
  );
  await stores.analytics.put(
    analyticsRecord(abandonedId, "abandoned", {
      reason: "cancelled",
      updatedAt: new Date("2026-08-30T12:00:02.000Z"),
    }),
  );
  assert.equal(
    (await stores.analytics.get(workspaceId, abandonedId, scope()))?.reason,
    "user-cancelled",
    `${name} replaced an explicit cancellation with a transport reason`,
  );
  await stores.analytics.put(
    analyticsRecord(abandonedId, "answered", {
      reason: "late provider completion",
      updatedAt: new Date("2026-08-30T12:00:03.000Z"),
    }),
  );
  const abandoned = await stores.analytics.get(workspaceId, abandonedId, scope());
  assert.equal(abandoned?.outcome, "abandoned", `${name} lost explicit cancellation`);
  assert.equal(abandoned?.reason, "user-cancelled");
  assert.equal(
    await stores.analytics.updateOutcome({
      id: abandonedId,
      outcome: "low-rated",
      reason: "cancelled answer was unhelpful",
      scope: scope(),
      updatedAt: new Date("2026-08-30T12:00:04.000Z"),
      workspaceId,
    }),
    true,
  );
  await stores.analytics.put(
    analyticsRecord(abandonedId, "abandoned", {
      reason: "late pagehide",
      updatedAt: new Date("2026-08-30T12:00:05.000Z"),
    }),
  );
  assert.equal(
    await stores.analytics.updateOutcome({
      id: abandonedId,
      outcome: "abandoned",
      reason: "later cancellation",
      scope: scope(),
      updatedAt: new Date("2026-08-30T12:00:06.000Z"),
      workspaceId,
    }),
    false,
  );
  const ratedAbandonment = await stores.analytics.get(
    workspaceId,
    abandonedId,
    scope(),
  );
  assert.equal(ratedAbandonment?.outcome, "low-rated");
  assert.equal(ratedAbandonment?.reason, "cancelled answer was unhelpful");

  const equalCancellationId = "123e456c-e89b-42d3-a456-426614174000";
  const cancellationAt = new Date("2026-08-30T12:00:01.000Z");
  await stores.analytics.put(
    analyticsRecord(equalCancellationId, "abandoned", {
      reason: conversationStreamActiveReason,
    }),
  );
  assert.equal(
    await stores.analytics.updateOutcome({
      id: equalCancellationId,
      outcome: "abandoned",
      reason: "page-closed",
      scope: scope(),
      updatedAt: cancellationAt,
      workspaceId,
    }),
    true,
  );
  await stores.analytics.put(
    analyticsRecord(equalCancellationId, "abandoned", {
      reason: "cancelled",
      updatedAt: cancellationAt,
    }),
  );
  assert.equal(
    (
      await stores.analytics.get(workspaceId, equalCancellationId, scope())
    )?.reason,
    "page-closed",
    `${name} replaced an equal-time explicit cancellation`,
  );

  const nullableAbandonedId = "123e456b-e89b-42d3-a456-426614174000";
  await stores.analytics.put(
    analyticsRecord(nullableAbandonedId, "abandoned", { reason: null }),
  );
  await stores.analytics.put(
    analyticsRecord(nullableAbandonedId, "answered", {
      updatedAt: new Date("2026-08-30T12:00:01.000Z"),
    }),
  );
  const nullableAbandonment = await stores.analytics.get(
    workspaceId,
    nullableAbandonedId,
    scope(),
  );
  assert.equal(nullableAbandonment?.outcome, "abandoned");
  assert.equal(nullableAbandonment?.reason, null);

  assert.equal(
    await stores.analytics.updateOutcome({
      id,
      outcome: "low-rated",
      reason: "reader reason",
      scope: scope(),
      updatedAt: new Date("2026-08-30T12:00:01.000Z"),
      workspaceId,
    }),
    true,
  );
  await stores.analytics.put(
    analyticsRecord(id, "answered", {
      reason: "late answered",
      updatedAt: new Date("2026-08-30T12:00:02.000Z"),
    }),
  );
  let retained = await stores.analytics.get(workspaceId, id, scope());
  assert.equal(retained?.outcome, "low-rated", `${name} lost a low rating`);
  assert.equal(retained?.reason, "reader reason");
  assert.equal(retained?.firstTokenMilliseconds, 275);
  assert.equal(retained?.conversation[0]?.content.includes("reader@example.com"), false);
  assert.equal(retained?.retrievalTrace[0]?.excerpt.includes("reader@company"), false);
  assert.deepEqual(retained?.retrievalTrace[0]?.headingPath, [
    "Account",
    "Reset password",
  ]);
  assert.deepEqual(retained?.retrievalTrace[0]?.sourceLineRange, {
    end: 9,
    start: 4,
  });

  await stores.analytics.put(
    analyticsRecord(id, "escalated", {
      reason: "support-handoff",
      updatedAt: new Date("2026-08-30T12:00:03.000Z"),
    }),
  );
  for (const outcome of ["abandoned", "low-rated"] as const) {
    assert.equal(
      await stores.analytics.updateOutcome({
        id,
        outcome,
        reason: "late outcome",
        scope: scope(),
        updatedAt: new Date("2026-08-30T12:00:04.000Z"),
        workspaceId,
      }),
      false,
    );
  }
  await stores.analytics.put(
    analyticsRecord(id, "abandoned", {
      reason: "pagehide",
      updatedAt: new Date("2026-08-30T12:00:05.000Z"),
    }),
  );
  retained = await stores.analytics.get(workspaceId, id, scope());
  assert.equal(retained?.outcome, "escalated", `${name} overwrote escalation`);
  assert.equal(retained?.reason, "support-handoff");

  const raceId = "abcdef01-e89b-42d3-a456-426614174001";
  await Promise.all(
    (["abandoned", "abstained", "answered", "low-rated", "escalated"] as const)
      .map((outcome, index) =>
        stores.analytics.put(
          analyticsRecord(raceId, outcome, {
            reason: outcome,
            updatedAt: new Date(current.getTime() + index),
          }),
        ),
      ),
  );
  assert.equal(
    (await stores.analytics.get(workspaceId, raceId, scope()))?.outcome,
    "escalated",
    `${name} did not reconcile concurrent outcomes deterministically`,
  );

  const collisionId = "123e4567-e89b-42d3-a456-426614174999";
  assert.equal(
    await stores.analytics.put(analyticsRecord(collisionId, "answered")),
    false,
    `${name} exceeded the deterministic daily slot bound`,
  );

  const expiredId = "fedcba98-e89b-42d3-a456-426614174002";
  const expired = analyticsRecord(expiredId, "answered", {
    bucketDay: "20260601",
    expiresAt: new Date("2026-07-01T12:00:00.000Z"),
    startedAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:01.000Z"),
  });
  assert.equal(await stores.analytics.put(expired), true);
  assert.equal(await stores.analytics.get(workspaceId, expiredId, scope()), null);
  assert.equal(
    await stores.analytics.cleanup({ limit: 1, scope: scope(), workspaceId }),
    1,
  );
  assert.equal(await stores.rawAnalyticsCount(), 8);
  await stores.corruptAnalyticsTrace(raceId);
  await assert.rejects(
    stores.analytics.get(workspaceId, raceId, scope()),
    /Stored retrieval analytics are invalid/u,
    `${name} accepted malformed retained provenance`,
  );

  const admission = createHandoffWriteAdmission({
    environment: { OPAS_HANDOFF_DAILY_LIMIT: "3" },
    now: () => current,
    store: stores.publicWrites,
    workspaceId,
  });
  const allowances = await Promise.all(
    Array.from({ length: 12 }, (_, index) => admission.reserve(reservationId(index + 1))),
  );
  assert.equal(
    allowances.filter(({ accepted }) => accepted).length,
    3,
    `${name} overspent the durable handoff cap`,
  );
  const acceptedId = reservationId(
    allowances.findIndex(({ accepted }) => accepted) + 1,
  );
  assert.deepEqual(await admission.reserve(acceptedId), { accepted: true });
  const denied = allowances.find(
    (allowance): allowance is { accepted: false; retryAfterSeconds: number } =>
      !allowance.accepted,
  );
  assert.equal(denied?.retryAfterSeconds, 86_400);
  assert.equal(await stores.rawPublicWriteCount(), 3);
  assert.equal(
    await stores.publicWrites.cleanup(
      workspaceId,
      new Date("2026-10-01T12:00:00.000Z"),
      2,
    ),
    2,
  );
  assert.equal(await stores.rawPublicWriteCount(), 1);

  const outcomeAdmissions = [stores.publicWrites, stores.secondaryPublicWrites].map(
    (store) =>
      createOutcomeWriteAdmission({
        now: () => current,
        store,
        workspaceId,
      }),
  );
  const outcomeAllowances = await Promise.all(
    Array.from({ length: maximumOutcomeWritesPerWindow + 12 }, (_, index) =>
      outcomeAdmissions[index % outcomeAdmissions.length]!.reserve(),
    ),
  );
  assert.equal(
    outcomeAllowances.filter(({ accepted }) => accepted).length,
    maximumOutcomeWritesPerWindow,
    `${name} overspent the durable outcome cap`,
  );
  const deniedOutcome = outcomeAllowances.find(
    (allowance): allowance is { accepted: false; retryAfterSeconds: number } =>
      !allowance.accepted,
  );
  assert.equal(deniedOutcome?.retryAfterSeconds, 60);
  assert.deepEqual(await stores.rawOutcomeWindow(), {
    windowStartedAt: current.getTime(),
    writeCount: maximumOutcomeWritesPerWindow,
  });
  assert.deepEqual(
    await createOutcomeWriteAdmission({
      now: () => new Date(current.getTime() + 59_999),
      store: stores.publicWrites,
      workspaceId,
    }).reserve(),
    { accepted: false, retryAfterSeconds: 1 },
  );
  assert.deepEqual(
    await createOutcomeWriteAdmission({
      now: () => new Date(current.getTime() - 60_000),
      store: stores.secondaryPublicWrites,
      workspaceId,
    }).reserve(),
    { accepted: false, retryAfterSeconds: 60 },
  );
  assert.deepEqual(
    await createOutcomeWriteAdmission({
      now: () => new Date(current.getTime() + 60_000),
      store: stores.publicWrites,
      workspaceId,
    }).reserve(),
    { accepted: true },
  );
  assert.deepEqual(await stores.rawOutcomeWindow(), {
    windowStartedAt: current.getTime() + 60_000,
    writeCount: 1,
  });
  assert.equal(
    await stores.publicWrites.cleanup(
      workspaceId,
      new Date("2026-10-01T12:00:00.000Z"),
      1_000,
    ),
    1,
  );
  assert.equal(await stores.rawPublicWriteCount(), 0);
  assert.deepEqual(await stores.rawOutcomeWindow(), {
    windowStartedAt: current.getTime() + 60_000,
    writeCount: 1,
  });

  const oldHandoffId = "323e4567-e89b-42d3-a456-426614174000";
  const activeHandoffId = "423e4567-e89b-42d3-a456-426614174000";
  await stores.handoffs.reserve(
    handoffRecord(oldHandoffId, new Date("2026-07-01T00:00:00.000Z")),
  );
  await stores.handoffs.reserve(handoffRecord(activeHandoffId, current));
  assert.equal(
    await stores.handoffs.cleanup(
      workspaceId,
      new Date("2026-07-31T12:00:00.000Z"),
      1,
    ),
    1,
  );
  assert.equal(await stores.rawHandoffCount(), 1);
}

type D1Bound = Readonly<{
  all(): Promise<unknown>;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
  execute(): unknown;
}>;

function createD1Facade(client: Database.Database) {
  const result = (results: unknown[], changes = 0) => ({
    meta: { changes },
    results,
    success: true,
  });
  const d1 = {
    prepare(source: string) {
      return {
        bind(...parameters: unknown[]): D1Bound {
          const returnsRows = /^\s*(?:select|with)\b/iu.test(source) || /\breturning\b/iu.test(source);
          const execute = () => {
            if (returnsRows) return result(client.prepare(source).all(...parameters) as unknown[]);
            const changed = client.prepare(source).run(...parameters);
            return result([], changed.changes);
          };
          return {
            async all() {
              return execute();
            },
            execute,
            async first<T>() {
              return (client.prepare(source).get(...parameters) as T | undefined) ?? null;
            },
            async run() {
              return execute();
            },
          };
        },
      };
    },
    async batch(statements: readonly D1Bound[]) {
      return client.transaction((items: readonly D1Bound[]) =>
        items.map((statement) => statement.execute()),
      )(statements);
    },
  } as unknown as AnyD1Database;
  return createD1Database(d1, { schema: sqliteSchema });
}

function migratedSqlite() {
  const client = new Database(":memory:");
  client.pragma("foreign_keys = ON");
  const database = createSqliteDatabase(client, { schema: sqliteSchema });
  migrateSqlite(database, { migrationsFolder: path.join(process.cwd(), "drizzle/sqlite") });
  client
    .prepare("insert into workspaces (id, slug, name) values (?, ?, ?)")
    .run(workspaceId, "demo", "Demo");
  return { client, database };
}

function sqliteStores(
  client: Database.Database,
  database: Parameters<typeof createSqliteConversationAnalyticsStore>[0],
): StoreSet {
  const count = async (table: string) =>
    Number((client.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count);
  return {
    analytics: createSqliteConversationAnalyticsStore(database),
    async corruptAnalyticsTrace(recordId) {
      client
        .prepare(
          "update conversation_analytics set retrieval_trace = ? where id = ? and workspace_id = ?",
        )
        .run(JSON.stringify([{ sourceId: "invalid" }]), recordId, workspaceId);
    },
    handoffs: createSqliteSupportHandoffStore(database),
    publicWrites: createSqlitePublicWriteAdmissionStore(database),
    secondaryPublicWrites: createSqlitePublicWriteAdmissionStore(database),
    rawAnalyticsCount: () => count("conversation_analytics"),
    rawHandoffCount: () => count("support_handoffs"),
    async rawOutcomeWindow() {
      const row = client
        .prepare(
          "select window_started_at as windowStartedAt, write_count as writeCount from public_outcome_write_windows where workspace_id = ?",
        )
        .get(workspaceId) as
        | Readonly<{ windowStartedAt: number; writeCount: number }>
        | undefined;
      return row ?? null;
    },
    rawPublicWriteCount: () => count("public_write_reservations"),
  };
}

test("portable privacy stores pass on local SQLite", async () => {
  const { client, database } = migratedSqlite();
  try {
    await exerciseStores("SQLite", sqliteStores(client, database));
  } finally {
    client.close();
  }
});

test("portable privacy stores pass through D1 client semantics", async () => {
  const { client } = migratedSqlite();
  try {
    await exerciseStores("D1", sqliteStores(client, createD1Facade(client)));
  } finally {
    client.close();
  }
});

test(
  "portable privacy stores serialize real Postgres races",
  { timeout: 120_000 },
  async () => {
    const container = await new PostgreSqlContainer("postgres:18.6-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
    const unexpectedPoolErrors: Error[] = [];
    let closing = false;
    pool.on("error", (error) => {
      if (!closing) unexpectedPoolErrors.push(error);
    });
    const database = createPostgresDatabase(pool, { schema: postgresSchema });
    try {
      await migratePostgres(database, {
        migrationsFolder: path.join(process.cwd(), "drizzle/postgres"),
      });
      await pool.query(
        "insert into workspaces (id, slug, name) values ($1, $2, $3)",
        [workspaceId, "demo", "Demo"],
      );
      const count = async (table: string) =>
        Number((await pool.query(`select count(*)::integer as count from ${table}`)).rows[0].count);
      await exerciseStores("Postgres", {
        analytics: createPostgresConversationAnalyticsStore(database),
        async corruptAnalyticsTrace(recordId) {
          await pool.query(
            "update conversation_analytics set retrieval_trace = $1::jsonb where id = $2 and workspace_id = $3",
            [JSON.stringify([{ sourceId: "invalid" }]), recordId, workspaceId],
          );
        },
        handoffs: createPostgresSupportHandoffStore(database),
        publicWrites: createPostgresPublicWriteAdmissionStore(database),
        secondaryPublicWrites: createPostgresPublicWriteAdmissionStore(database),
        rawAnalyticsCount: () => count("conversation_analytics"),
        rawHandoffCount: () => count("support_handoffs"),
        async rawOutcomeWindow() {
          const result = await pool.query<{
            windowStartedAt: Date;
            writeCount: number;
          }>(
            'select window_started_at as "windowStartedAt", write_count::integer as "writeCount" from public_outcome_write_windows where workspace_id = $1',
            [workspaceId],
          );
          const row = result.rows[0];
          return row
            ? {
                windowStartedAt: row.windowStartedAt.getTime(),
                writeCount: row.writeCount,
              }
            : null;
        },
        rawPublicWriteCount: () => count("public_write_reservations"),
      });
    } finally {
      const unexpectedPoolError = unexpectedPoolErrors[0];
      closing = true;
      await pool.end();
      await container.stop();
      if (unexpectedPoolError) throw unexpectedPoolError;
    }
  },
);
