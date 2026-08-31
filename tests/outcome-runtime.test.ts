// ABOUTME: Verifies analytics runtime retention, cleanup draining, and delayed feedback races.
// ABOUTME: Proves disabled analytics is inert while handoff cleanup remains independent.
import assert from "node:assert/strict";
import test from "node:test";

import { createAnswerOutcomeRecorder } from "@/outcomes/answer-recorder";
import { recordConfiguredPublicOutcome } from "@/outcomes/public";
import {
  createConversationAnalyticsRuntime,
  runConfiguredAnalyticsCleanup,
} from "@/outcomes/runtime";
import type {
  ConversationAnalyticsCleanup,
  ConversationAnalyticsReadScope,
  ConversationAnalyticsStore,
  ConversationOutcomeUpdate,
} from "@/outcomes/store";
import {
  conversationStreamActiveReason,
  type ConversationAnalyticsRecord,
} from "@/outcomes/records";
import type { HandoffStore } from "@/handoff/service";
import type { PublicWriteAdmissionStore } from "@/outcomes/admission";

const id = "123e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-08-30T12:00:00.000Z");

class MemoryAnalyticsStore implements ConversationAnalyticsStore {
  readonly records = new Map<string, ConversationAnalyticsRecord>();
  readonly cleanupRequests: ConversationAnalyticsCleanup[] = [];
  readonly scopes: ConversationAnalyticsReadScope[] = [];
  putDelay: (() => Promise<void>) | null = null;

  async cleanup(request: ConversationAnalyticsCleanup) {
    this.cleanupRequests.push(request);
    return 0;
  }

  async get(_workspaceId: string, recordId: string, scope: ConversationAnalyticsReadScope) {
    this.scopes.push(scope);
    return this.records.get(recordId) ?? null;
  }

  async list(_workspaceId: string, scope: ConversationAnalyticsReadScope) {
    this.scopes.push(scope);
    return [...this.records.values()];
  }

  async put(record: ConversationAnalyticsRecord) {
    await this.putDelay?.();
    this.records.set(record.id, record);
    return true;
  }

  async updateOutcome(request: ConversationOutcomeUpdate) {
    const record = this.records.get(request.id);
    if (!record) return false;
    this.records.set(
      request.id,
      Object.freeze({
        ...record,
        outcome: request.outcome,
        reason: request.reason,
        updatedAt: request.updatedAt,
      }),
    );
    return true;
  }
}

function input() {
  return {
    conversation: [{ content: "Question", role: "user" as const }],
    durationMilliseconds: 100,
    id,
    model: "fixture-model",
    outcome: "answered" as const,
    provider: "openai-compatible",
    retrievalTrace: [],
    startedAt: new Date("2026-08-30T11:59:59.900Z"),
    updatedAt: now,
    workspaceId: "workspace_demo",
  };
}

test("applies current retention to every read and makes disablement an inert write path", async () => {
  const store = new MemoryAnalyticsStore();
  const runtime = createConversationAnalyticsRuntime({
    environment: { OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "7" },
    now: () => now,
    store,
  });
  assert.equal(runtime.status, "enabled");
  assert.equal(await runtime.put(input()), true);
  await runtime.get("workspace_demo", id);
  await runtime.list("workspace_demo", 10);
  assert.equal(store.scopes.length, 2);
  for (const scope of store.scopes) {
    assert.equal(scope.readAt.toISOString(), now.toISOString());
    assert.equal(scope.retentionStartedAt.toISOString(), "2026-08-23T12:00:00.000Z");
  }

  const disabledStore = new MemoryAnalyticsStore();
  const disabled = createConversationAnalyticsRuntime({
    environment: { OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "0" },
    now: () => now,
    store: disabledStore,
  });
  assert.equal(disabled.status, "disabled");
  assert.equal(await disabled.put(input()), false);
  assert.equal(await disabled.updateOutcome(id, "low-rated", "reason"), false);
  assert.deepEqual(await disabled.list("workspace_demo", 10), []);
  assert.equal(disabledStore.records.size, 0);
});

test("fails closed on invalid privacy configuration before reading or writing", async () => {
  const store = new MemoryAnalyticsStore();
  const runtime = createConversationAnalyticsRuntime({
    environment: { OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "31" },
    now: () => now,
    store,
  });
  assert.equal(runtime.status, "unavailable");
  await assert.rejects(runtime.put(input()), /analytics are unavailable/u);
  await assert.rejects(runtime.get("workspace_demo", id), /analytics are unavailable/u);
  assert.equal(store.records.size, 0);
});

test("public outcomes retry an in-flight server write but never create a random record", async () => {
  const store = new MemoryAnalyticsStore();
  let releasePut: (() => void) | undefined;
  const blockedPut = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  store.putDelay = () => blockedPut;
  const runtime = createConversationAnalyticsRuntime({ now: () => now, store });
  const recorder = createAnswerOutcomeRecorder({
    getRuntime: async () => runtime,
    id,
    model: "fixture-model",
    now: () => now,
    provider: "openai-compatible",
    question: "Question",
    startedAt: new Date("2026-08-30T11:59:59.900Z"),
    workspaceId: "workspace_demo",
    writeDeadlineMilliseconds: 1,
  });
  await recorder.observeEvent({
    reason: "stop",
    type: "finish",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  assert.equal(store.records.size, 0);

  let waits = 0;
  const result = await recordConfiguredPublicOutcome(
    id,
    "low-rated",
    "The answer skipped a step.",
    {
      getRuntime: async () => runtime,
      wait: async () => {
        waits += 1;
        releasePut?.();
        await blockedPut;
      },
    },
  );
  assert.equal(result, "updated");
  assert.equal(waits, 1);
  assert.equal(store.records.get(id)?.outcome, "low-rated");

  const randomId = "223e4567-e89b-42d3-a456-426614174000";
  const missing = await recordConfiguredPublicOutcome(
    randomId,
    "low-rated",
    null,
    { getRuntime: async () => runtime, wait: async () => {} },
  );
  assert.equal(missing, "missing");
  assert.equal(store.records.has(randomId), false);
});

test("records an active stream before metadata and replaces it on completion", async () => {
  const store = new MemoryAnalyticsStore();
  const runtime = createConversationAnalyticsRuntime({ now: () => now, store });
  const clock = recorderClock([50, 450]);
  const recorder = createAnswerOutcomeRecorder({
    getRuntime: async () => runtime,
    id,
    model: "fixture-model",
    now: clock.now,
    provider: "openai-compatible",
    question: "Question",
    startedAt: clock.startedAt,
    workspaceId: "workspace_demo",
  });

  await recorder.observeEvent({ markdown: "First", type: "content" });
  const firstStart = recorder.start();
  assert.equal(recorder.start(), firstStart);
  await firstStart;
  assert.equal(store.records.get(id)?.outcome, "abandoned");
  assert.equal(store.records.get(id)?.reason, conversationStreamActiveReason);

  await recorder.observeEvent({
    reason: "stop",
    type: "finish",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  assert.equal(store.records.get(id)?.outcome, "answered");
  assert.equal(store.records.get(id)?.reason, "stop");

  const abstainedId = "223e4567-e89b-42d3-a456-426614174000";
  const abstainedClock = recorderClock([40, 250]);
  const abstainedRecorder = createAnswerOutcomeRecorder({
    getRuntime: async () => runtime,
    id: abstainedId,
    model: "fixture-model",
    now: abstainedClock.now,
    provider: "openai-compatible",
    question: "Unsupported question",
    startedAt: abstainedClock.startedAt,
    workspaceId: "workspace_demo",
  });
  await abstainedRecorder.start();
  await abstainedRecorder.observeEvent({
    message: "Not enough published evidence.",
    reason: "insufficient-evidence",
    type: "abstention",
  });
  assert.equal(store.records.get(abstainedId)?.outcome, "abstained");
  assert.equal(store.records.get(abstainedId)?.reason, "insufficient-evidence");
});

function recorderClock(milliseconds: readonly number[]) {
  const startedAt = new Date("2026-08-30T12:00:00.000Z");
  let index = 0;
  return {
    now: () =>
      new Date(startedAt.getTime() + (milliseconds[index++] ?? 300_000)),
    startedAt,
  };
}

test("records first content token once and total request latency for every terminal path", async (context) => {
  await context.test("answered", async () => {
    const store = new MemoryAnalyticsStore();
    const runtime = createConversationAnalyticsRuntime({ now: () => now, store });
    const clock = recorderClock([100, 450]);
    const recorder = createAnswerOutcomeRecorder({
      environment: {
        OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1000000",
        OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "2000000",
        OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1",
        OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1",
      },
      getRuntime: async () => runtime,
      id,
      model: "fixture-model",
      now: clock.now,
      provider: "openai-compatible",
      question: "Question",
      startedAt: clock.startedAt,
      workspaceId: "workspace_demo",
    });
    recorder.observeProvider({
      model: "fallback-model",
      provider: "cloudflare-workers-ai",
    });
    await recorder.observeEvent({ markdown: "First", type: "content" });
    await recorder.observeEvent({ markdown: "Second", type: "content" });
    await recorder.observeEvent({
      reason: "stop",
      type: "finish",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    assert.equal(store.records.get(id)?.firstTokenMilliseconds, 100);
    assert.equal(store.records.get(id)?.durationMilliseconds, 450);
    assert.equal(store.records.get(id)?.provider, "cloudflare-workers-ai");
    assert.equal(store.records.get(id)?.model, "fallback-model");
    assert.equal(store.records.get(id)?.costMicrodollars, 20);
  });

  await context.test("abstained", async () => {
    const store = new MemoryAnalyticsStore();
    const runtime = createConversationAnalyticsRuntime({ now: () => now, store });
    const clock = recorderClock([90]);
    const recorder = createAnswerOutcomeRecorder({
      getRuntime: async () => runtime,
      id,
      model: "fixture-model",
      now: clock.now,
      provider: "openai-compatible",
      question: "Question",
      startedAt: clock.startedAt,
      workspaceId: "workspace_demo",
    });
    await recorder.observeEvent({
      message: "I do not have enough published evidence.",
      reason: "insufficient-evidence",
      type: "abstention",
    });
    assert.equal(store.records.get(id)?.outcome, "abstained");
    assert.equal(store.records.get(id)?.firstTokenMilliseconds, null);
    assert.equal(store.records.get(id)?.durationMilliseconds, 90);
  });

  await context.test("failed before a content token", async () => {
    const store = new MemoryAnalyticsStore();
    const runtime = createConversationAnalyticsRuntime({ now: () => now, store });
    const clock = recorderClock([300]);
    const recorder = createAnswerOutcomeRecorder({
      getRuntime: async () => runtime,
      id,
      model: "fixture-model",
      now: clock.now,
      provider: "openai-compatible",
      question: "Question",
      startedAt: clock.startedAt,
      workspaceId: "workspace_demo",
    });
    await recorder.abandon("request-failed");
    assert.equal(store.records.get(id)?.firstTokenMilliseconds, null);
    assert.equal(store.records.get(id)?.durationMilliseconds, 300);
  });

  await context.test("cancelled after a content token", async () => {
    const store = new MemoryAnalyticsStore();
    const runtime = createConversationAnalyticsRuntime({ now: () => now, store });
    const clock = recorderClock([50, 70]);
    const recorder = createAnswerOutcomeRecorder({
      getRuntime: async () => runtime,
      id,
      model: "fixture-model",
      now: clock.now,
      provider: "openai-compatible",
      question: "Question",
      startedAt: clock.startedAt,
      workspaceId: "workspace_demo",
    });
    await recorder.observeEvent({ markdown: "Partial", type: "content" });
    await recorder.abandon("cancelled");
    assert.equal(store.records.get(id)?.firstTokenMilliseconds, 50);
    assert.equal(store.records.get(id)?.durationMilliseconds, 70);
  });
});

function drainingCounter(values: readonly number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}

test("cleanup repeatedly drains conversations, public writes, and separate handoff contacts", async () => {
  const analyticsValues = drainingCounter([1_000, 1_000, 24, 0]);
  const publicWriteValues = drainingCounter([1_000, 4, 0, 0]);
  const handoffValues = drainingCounter([1_000, 1_000, 1_000, 7]);
  const handoffCutoffs: Date[] = [];
  const analyticsStore = new MemoryAnalyticsStore();
  analyticsStore.cleanup = async (request) => {
    analyticsStore.cleanupRequests.push(request);
    return analyticsValues();
  };
  const publicWriteStore = {
    cleanup: async () => publicWriteValues(),
    reserve: async () => ({ accepted: true as const }),
  } satisfies PublicWriteAdmissionStore;
  const handoffStore = {
    cleanup: async (_workspaceId: string, createdBefore: Date) => {
      handoffCutoffs.push(createdBefore);
      return handoffValues();
    },
    finish: async () => {},
    reserve: async () => ({ state: "reserved" as const }),
  } satisfies HandoffStore;

  const result = await runConfiguredAnalyticsCleanup({
    analyticsStore,
    environment: {
      OPAS_ANSWER_ANALYTICS_RETENTION_DAYS: "0",
      OPAS_HANDOFF_RETENTION_DAYS: "14",
    },
    handoffStore,
    now: () => now,
    publicWriteStore,
  });

  assert.deepEqual(result, {
    batches: 4,
    conversations: 2_024,
    handoffs: 3_007,
    publicWrites: 1_004,
  });
  assert.equal(handoffCutoffs.length, 4);
  assert.equal(handoffCutoffs[0]?.toISOString(), "2026-08-16T12:00:00.000Z");
  assert.equal(
    analyticsStore.cleanupRequests[0]?.scope.retentionStartedAt > now,
    true,
  );
});

test("rejects handoff retention outside 1 to 365 days", async () => {
  for (const value of ["0", "366", "01", "-1", "1.5"]) {
    await assert.rejects(
      runConfiguredAnalyticsCleanup({
        analyticsStore: new MemoryAnalyticsStore(),
        environment: { OPAS_HANDOFF_RETENTION_DAYS: value },
        handoffStore: {
          cleanup: async () => 0,
          finish: async () => {},
          reserve: async () => ({ state: "reserved" as const }),
        },
        now: () => now,
        publicWriteStore: {
          cleanup: async () => 0,
          reserve: async () => ({ accepted: true as const }),
        },
      }),
      /handoff retention is unavailable/u,
    );
  }
});
