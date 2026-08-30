// ABOUTME: Selects deployment repositories and retention-scoped analytics for the quality console.
// ABOUTME: Binds every administrator operation to the single active demo workspace on the server.
import "server-only";

import {
  createConfiguredAnswerRuntime,
  createConfiguredRetainedAnswerRuntime,
} from "@/answers/answer-runtime";
import { createAnswerRequestGate } from "@/answers/gate";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";
import {
  conversationAnalyticsRetentionStartedAt,
  createConversationAnalyticsPolicy,
  type ConversationAnalyticsEnvironment,
} from "@/outcomes/records";
import {
  createContentGapReport,
  maximumContentGapRecords,
} from "@/gaps/report";
import { getConfiguredConversationAnalyticsStore } from "@/outcomes/storage-runtime";
import {
  conversationQualityCsv,
  evaluationQualityCsv,
} from "@/quality/console";
import { importSavedQuestionSet } from "@/quality/question-set-import";
import { importQualityReview } from "@/quality/review-import";
import {
  loadQualityConsoleData,
  runRetainedConversationReplay,
  runQualityPlayground,
  runSavedQuestionSet,
  type QualityAnalyticsAccess,
  type QualityRuntimeDependencies,
} from "@/quality/runtime";

export const consumeQualityRequestAllowance = createAnswerRequestGate(
  async () => null,
);

async function qualityAnalyticsAccess(now: Date): Promise<QualityAnalyticsAccess> {
  const policy = createConversationAnalyticsPolicy(
    process.env as ConversationAnalyticsEnvironment,
  );
  if (policy.status !== "enabled") return policy;
  try {
    return Object.freeze({
      scope: Object.freeze({
        readAt: now,
        retentionStartedAt: conversationAnalyticsRetentionStartedAt(
          now,
          policy.retentionDays,
        ),
      }),
      status: "enabled" as const,
      store: await getConfiguredConversationAnalyticsStore(),
    });
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
}

async function qualityRuntimeDependencies(): Promise<QualityRuntimeDependencies> {
  const costRates = [
    Object.freeze({
      inputMicrodollarsPerMillionTokens:
        process.env.OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS,
      model: process.env.OPAS_GENERATION_MODEL ?? "",
      outputMicrodollarsPerMillionTokens:
        process.env.OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS,
      provider:
        process.env.OPAS_DATABASE_DRIVER === "d1"
          ? "cloudflare-workers-ai"
          : "openai-compatible",
    }),
    ...(process.env.OPAS_GENERATION_FALLBACK_ENABLED === "true"
      ? [
          Object.freeze({
            inputMicrodollarsPerMillionTokens:
              process.env
                .OPAS_ANSWER_FALLBACK_INPUT_MICRODOLLARS_PER_MILLION_TOKENS,
            model: process.env.OPAS_GENERATION_FALLBACK_MODEL ?? "",
            outputMicrodollarsPerMillionTokens:
              process.env
                .OPAS_ANSWER_FALLBACK_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS,
            provider: process.env.OPAS_GENERATION_FALLBACK_PROVIDER ?? "",
          }),
        ]
      : []),
  ];
  return Object.freeze({
    costRates: Object.freeze(costRates),
    createAnswerRuntime: createConfiguredAnswerRuntime,
    repository: await getRepository(),
  });
}

export async function loadActiveQualityConsoleData(now = new Date()) {
  const dependencies = await qualityRuntimeDependencies();
  const analytics = await qualityAnalyticsAccess(now);
  const topicConfiguration = process.env.OPAS_ANSWER_TOPIC_GUARDRAILS;
  const [data, contentGapRecords] = await Promise.all([
    loadQualityConsoleData(
      demoIds.workspace,
      dependencies.repository,
      analytics,
    ),
    analytics.status === "enabled"
      ? analytics.store.list(
          demoIds.workspace,
          analytics.scope,
          maximumContentGapRecords,
        )
      : Promise.resolve([]),
  ]);
  return Object.freeze({
    ...data,
    contentGapReport: createContentGapReport({
      records: contentGapRecords,
      scope:
        analytics.status === "enabled"
          ? analytics.scope
          : Object.freeze({ readAt: now, retentionStartedAt: now }),
      topicConfiguration: topicConfiguration === "" ? undefined : topicConfiguration,
      workspaceId: demoIds.workspace,
    }),
  });
}

export async function runActiveSavedQuestionSet(questionSetId: string) {
  return runSavedQuestionSet(
    demoIds.workspace,
    questionSetId,
    await qualityRuntimeDependencies(),
  );
}

export async function importActiveSavedQuestionSet(value: unknown) {
  const repository = await getRepository();
  return importSavedQuestionSet(
    demoIds.workspace,
    value,
    repository,
  );
}

export async function importActiveQualityReview(value: unknown) {
  return importQualityReview(
    demoIds.workspace,
    value,
    await getRepository(),
  );
}

export async function runActiveQualityPlayground(question: string) {
  return runQualityPlayground(
    demoIds.workspace,
    question,
    await qualityRuntimeDependencies(),
  );
}

export async function runActiveRetainedConversationReplay(
  conversationId: string,
  now = new Date(),
) {
  return runRetainedConversationReplay(
    demoIds.workspace,
    conversationId,
    await qualityAnalyticsAccess(now),
    { createAnswerRuntime: createConfiguredRetainedAnswerRuntime },
  );
}

export async function exportActiveQualityCsv(
  kind: "conversations" | "evaluations",
) {
  const data = await loadActiveQualityConsoleData();
  return kind === "conversations"
    ? conversationQualityCsv(data.conversations)
    : evaluationQualityCsv(data.runs);
}
