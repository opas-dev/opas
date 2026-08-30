// ABOUTME: Verifies strict inference budgets and conservative lease reconciliation.
// ABOUTME: Proves usage accounting is integer-only, idempotent, bounded, and redacted.
import assert from "node:assert/strict";
import test from "node:test";

import {
  AnswerAdmissionError,
  createAnswerAdmissionPolicy,
  createAnswerInferenceAdmission,
  maximumAnswerInferenceCost,
  type AnswerAdmissionEnvironment,
} from "@/answers/admission";
import type {
  AnswerInferenceLease,
  AnswerInferenceReconciliation,
  AnswerInferenceRepository,
  AnswerInferenceReservation,
} from "@/db/repository";

const startedAt = new Date("2026-08-30T12:00:00.000Z");

function environment(
  overrides: Partial<AnswerAdmissionEnvironment> = {},
): AnswerAdmissionEnvironment {
  return {
    OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS: "1000000",
    OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "152000",
    OPAS_ANSWER_LEASE_MILLISECONDS: "45000",
    OPAS_ANSWER_MAXIMUM_CONCURRENCY: "4",
    OPAS_ANSWER_MAXIMUM_INPUT_TOKENS: "32000",
    OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "287000",
    ...overrides,
  };
}

function activeLease(
  reservation: AnswerInferenceReservation,
): AnswerInferenceLease {
  return {
    id: reservation.id,
    workspaceId: reservation.workspaceId,
    provider: reservation.provider,
    model: reservation.model,
    maximumOutputTokens: reservation.maximumOutputTokens,
    reservedMicrodollars: reservation.reservedMicrodollars,
    chargedMicrodollars: null,
    status: "active",
    inputTokens: null,
    outputTokens: null,
    startedAt: reservation.startedAt,
    expiresAt: reservation.expiresAt,
    reconciledAt: null,
  };
}

function repositoryFixture() {
  let lease: AnswerInferenceLease | null = null;
  const reservations: AnswerInferenceReservation[] = [];
  const reconciliations: AnswerInferenceReconciliation[] = [];
  const repository: AnswerInferenceRepository = {
    async reserveAnswerInference(reservation) {
      reservations.push(reservation);
      lease = activeLease(reservation);
      return lease;
    },
    async reconcileAnswerInference(reconciliation) {
      reconciliations.push(reconciliation);
      if (!lease) return null;
      if (lease.status === "active") {
        lease = {
          ...lease,
          ...reconciliation,
        };
      }
      return lease;
    },
    async getAnswerInferenceLease() {
      return lease;
    },
  };
  return { reconciliations, repository, reservations };
}

test("parses exact integer admission policy and reserves the maximum token cost", () => {
  const policy = createAnswerAdmissionPolicy(environment(), 1_024);

  assert.deepEqual(policy, {
    dailyBudgetMicrodollars: 1_000_000,
    inputMicrodollarsPerMillionTokens: 152_000,
    leaseMilliseconds: 45_000,
    maximumConcurrency: 4,
    maximumInputTokens: 32_000,
    outputMicrodollarsPerMillionTokens: 287_000,
    primaryInputMicrodollarsPerMillionTokens: 152_000,
    primaryOutputMicrodollarsPerMillionTokens: 287_000,
  });
  assert.equal(maximumAnswerInferenceCost(policy, 1_024), 5_158);
  assert.ok(Object.isFrozen(policy));
});

test("rejects missing, loose, zero-cost, undersized, and unbounded admission values", () => {
  const cases: Partial<AnswerAdmissionEnvironment>[] = [
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: undefined },
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: " 4" },
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: "04" },
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: "+4" },
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: "4.0" },
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: "0" },
    { OPAS_ANSWER_MAXIMUM_CONCURRENCY: "101" },
    { OPAS_ANSWER_LEASE_MILLISECONDS: "34999" },
    { OPAS_ANSWER_MAXIMUM_INPUT_TOKENS: "1000001" },
    {
      OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "0",
      OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "0",
    },
    { OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS: "1" },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => createAnswerAdmissionPolicy(environment(fixture), 1_024),
      (error) =>
        error instanceof AnswerAdmissionError &&
        error.category === "configuration" &&
        !JSON.stringify(error).includes(JSON.stringify(fixture)),
    );
  }
});

test("binds one provider identity to one lease and reconciles exact usage once", async () => {
  const fixture = repositoryFixture();
  const policy = createAnswerAdmissionPolicy(environment(), 1_024);
  const times = [startedAt, new Date(startedAt.getTime() + 1_000)];
  const admission = createAnswerInferenceAdmission({
    createId: () => "answer-lease-1",
    now: () => times.shift()!,
    policy,
    repository: fixture.repository,
  });
  const reservation = await admission.reserve({
    maximumOutputTokens: 1_024,
    model: "@cf/meta/llama-3.1-8b-instruct-fp8",
    provider: "cloudflare-workers-ai",
    workspaceId: "workspace-demo",
  });

  assert.equal(fixture.reservations.length, 1);
  assert.equal(fixture.reservations[0]?.reservedMicrodollars, 5_158);
  assert.equal(
    fixture.reservations[0]?.expiresAt.toISOString(),
    "2026-08-30T12:00:45.000Z",
  );
  assert.equal(
    fixture.reservations[0]?.spendWindowStartedAt.toISOString(),
    "2026-08-29T12:00:00.000Z",
  );

  const first = reservation.reconcile({
    outcome: "completed",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  });
  const second = reservation.reconcile({ outcome: "failed" });
  const [settledFirst, settledSecond] = await Promise.all([first, second]);

  assert.equal(first, second);
  assert.deepEqual(settledSecond, settledFirst);
  assert.equal(fixture.reconciliations.length, 1);
  assert.deepEqual(fixture.reconciliations[0], {
    id: "answer-lease-1",
    workspaceId: "workspace-demo",
    chargedMicrodollars: 7,
    inputTokens: 20,
    outputTokens: 8,
    reconciledAt: new Date("2026-08-30T12:00:01.000Z"),
    status: "completed",
  });
});

test("one fallback lease reserves both provider attempts", async () => {
  const fixture = repositoryFixture();
  const policy = createAnswerAdmissionPolicy(
    environment({
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "400000",
      OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "600000",
      OPAS_ANSWER_LEASE_MILLISECONDS: "65000",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
    }),
    1_024,
  );
  const times = [startedAt, new Date(startedAt.getTime() + 1_000)];
  const admission = createAnswerInferenceAdmission({
    createId: () => "answer-fallback-lease-1",
    now: () => times.shift()!,
    policy,
    repository: fixture.repository,
  });
  const reservation = await admission.reserve({
    maximumOutputTokens: 1_024,
    model: "primary-v1",
    provider: "cloudflare-workers-ai",
    workspaceId: "workspace-demo",
  });

  assert.equal(fixture.reservations.length, 1);
  assert.equal(fixture.reservations[0]?.reservedMicrodollars, 18_573);
  assert.equal(
    fixture.reservations[0]?.expiresAt.toISOString(),
    "2026-08-30T12:01:05.000Z",
  );
  await reservation.reconcile({
    generation: {
      model: "fallback-v2",
      provider: "openai-compatible",
    },
    outcome: "completed",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  });
  assert.equal(fixture.reconciliations.length, 1);
  assert.deepEqual(fixture.reconciliations[0], {
    chargedMicrodollars: 18_573,
    id: "answer-fallback-lease-1",
    inputTokens: null,
    outputTokens: null,
    reconciledAt: new Date("2026-08-30T12:00:01.000Z"),
    status: "completed",
    workspaceId: "workspace-demo",
  });
});

test("rejects fallback prices without opt-in and incomplete fallback budgets", () => {
  for (const overrides of [
    {
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1",
    },
    {
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
    },
    {
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "0",
      OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "0",
      OPAS_ANSWER_LEASE_MILLISECONDS: "65000",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
    },
    {
      OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1",
      OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS: "1",
      OPAS_ANSWER_LEASE_MILLISECONDS: "64999",
      OPAS_GENERATION_FALLBACK_ENABLED: "true",
    },
  ]) {
    assert.throws(
      () => createAnswerAdmissionPolicy(environment(overrides), 1_024),
      (error) =>
        error instanceof AnswerAdmissionError &&
        error.category === "configuration",
    );
  }
});

test("missing or out-of-contract usage retains the full conservative reservation", async (context) => {
  for (const usage of [
    undefined,
    { inputTokens: null, outputTokens: null, totalTokens: null },
    { inputTokens: 20, outputTokens: 8, totalTokens: 29 },
    { inputTokens: 32_001, outputTokens: 8, totalTokens: 32_009 },
    { inputTokens: 20, outputTokens: 1_025, totalTokens: 1_045 },
  ]) {
    await context.test(JSON.stringify(usage), async () => {
      const fixture = repositoryFixture();
      const admission = createAnswerInferenceAdmission({
        createId: () => "answer-lease-conservative",
        now: () => startedAt,
        policy: createAnswerAdmissionPolicy(environment(), 1_024),
        repository: fixture.repository,
      });
      const reservation = await admission.reserve({
        maximumOutputTokens: 1_024,
        model: "fixture-model",
        provider: "openai-compatible",
        workspaceId: "workspace-demo",
      });

      await reservation.reconcile({ outcome: "failed", usage });

      assert.equal(
        fixture.reconciliations[0]?.chargedMicrodollars,
        reservation.lease.reservedMicrodollars,
      );
      assert.equal(fixture.reconciliations[0]?.inputTokens, null);
      assert.equal(fixture.reconciliations[0]?.outputTokens, null);
    });
  }
});

test("reduces repository denial and outages to one private-free admission error", async () => {
  const policy = createAnswerAdmissionPolicy(environment(), 1_024);
  for (const reserveAnswerInference of [
    async () => null,
    async () => {
      throw new Error("private database URL and workspace details");
    },
  ]) {
    const admission = createAnswerInferenceAdmission({
      createId: () => "answer-lease-private",
      now: () => startedAt,
      policy,
      repository: {
        reserveAnswerInference,
        async reconcileAnswerInference() {
          throw new Error("not reached");
        },
        async getAnswerInferenceLease() {
          return null;
        },
      },
    });

    await assert.rejects(
      admission.reserve({
        maximumOutputTokens: 1_024,
        model: "fixture-model",
        provider: "openai-compatible",
        workspaceId: "workspace-demo",
      }),
      (error) =>
        error instanceof AnswerAdmissionError &&
        error.message === "Answer inference is unavailable" &&
        !error.message.includes("private"),
    );
  }
});
