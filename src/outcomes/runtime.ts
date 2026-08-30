// ABOUTME: Applies analytics configuration to portable redacted conversation storage.
// ABOUTME: Makes disabled analytics a no-op and keeps invalid configuration fail-closed.
import type { PublicWriteAdmissionStore } from "@/outcomes/admission";
import { demoIds } from "@/db/demo";
import {
  configuredHandoffRetentionDays,
  handoffRetentionStartedAt,
  type HandoffRetentionEnvironment,
} from "@/handoff/retention";
import type { HandoffStore } from "@/handoff/service";
import {
  conversationAnalyticsRetentionStartedAt,
  createConversationAnalyticsPolicy,
  normalizeConversationAnalyticsId,
  prepareConversationAnalyticsRecord,
  prepareConversationOutcomeReason,
  type ConversationAnalyticsEnvironment,
  type ConversationAnalyticsInput,
} from "@/outcomes/records";
import type { ConversationAnalyticsStore } from "@/outcomes/store";

const cleanupLimit = 1_000;
const maximumCleanupBatches = 32;
const disabledRetentionOffsetMilliseconds = 31 * 24 * 60 * 60 * 1_000;

type RuntimeDependencies = Readonly<{
  environment?: ConversationAnalyticsEnvironment;
  now?: () => Date;
  store: ConversationAnalyticsStore;
}>;

function safeNow(now: () => Date) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Conversation analytics are unavailable");
  }
  return value;
}

function selectedEnvironment(
  value: ConversationAnalyticsEnvironment | undefined,
): ConversationAnalyticsEnvironment {
  const source = (value ?? process.env) as Record<string, unknown>;
  return Object.freeze({
    OPAS_ANSWER_ANALYTICS_RETENTION_DAYS:
      typeof source.OPAS_ANSWER_ANALYTICS_RETENTION_DAYS === "string"
        ? source.OPAS_ANSWER_ANALYTICS_RETENTION_DAYS
        : undefined,
    OPAS_ANALYTICS_REDACTION_PATTERNS:
      typeof source.OPAS_ANALYTICS_REDACTION_PATTERNS === "string"
        ? source.OPAS_ANALYTICS_REDACTION_PATTERNS
        : undefined,
  });
}

export function createConversationAnalyticsRuntime(
  dependencies: RuntimeDependencies,
) {
  const policy = createConversationAnalyticsPolicy(
    selectedEnvironment(dependencies.environment),
  );
  const now = dependencies.now ?? (() => new Date());

  function enabledPolicy() {
    if (policy.status === "unavailable") {
      throw new Error("Conversation analytics are unavailable");
    }
    return policy.status === "enabled" ? policy : null;
  }

  function scope(readAt: Date) {
    const active = enabledPolicy();
    return {
      readAt,
      retentionStartedAt: active
        ? conversationAnalyticsRetentionStartedAt(readAt, active.retentionDays)
        : new Date(readAt.getTime() + disabledRetentionOffsetMilliseconds),
    };
  }

  return Object.freeze({
    status: policy.status,
    async put(input: ConversationAnalyticsInput) {
      const active = enabledPolicy();
      if (!active) return false;
      const record = prepareConversationAnalyticsRecord(input, active);
      return record ? dependencies.store.put(record) : false;
    },
    async updateOutcome(
      idValue: unknown,
      outcome: "abandoned" | "escalated" | "low-rated",
      reasonValue?: unknown,
    ) {
      const active = enabledPolicy();
      if (!active) return false;
      const id = normalizeConversationAnalyticsId(idValue);
      if (!id) return false;
      const updatedAt = safeNow(now);
      return dependencies.store.updateOutcome({
        id,
        outcome,
        reason: prepareConversationOutcomeReason(reasonValue, active),
        scope: scope(updatedAt),
        updatedAt,
        workspaceId: demoIds.workspace,
      });
    },
    async get(workspaceId: string, id: string) {
      if (!enabledPolicy()) return null;
      const readAt = safeNow(now);
      return dependencies.store.get(workspaceId, id, scope(readAt));
    },
    async list(workspaceId: string, limit: number) {
      if (!enabledPolicy()) return Object.freeze([]);
      const readAt = safeNow(now);
      return dependencies.store.list(workspaceId, scope(readAt), limit);
    },
    async cleanup() {
      if (policy.status === "unavailable") {
        throw new Error("Conversation analytics are unavailable");
      }
      const readAt = safeNow(now);
      return dependencies.store.cleanup({
        limit: cleanupLimit,
        scope: scope(readAt),
        workspaceId: demoIds.workspace,
      });
    },
  });
}

export async function createConfiguredConversationAnalyticsRuntime(
  dependencies: Readonly<{
    environment?: ConversationAnalyticsEnvironment;
    now?: () => Date;
    store?: ConversationAnalyticsStore;
  }> = {},
) {
  const store =
    dependencies.store ??
    (await (
      await import("@/outcomes/storage-runtime")
    ).getConfiguredConversationAnalyticsStore());
  return createConversationAnalyticsRuntime({
    environment: selectedEnvironment(dependencies.environment),
    now: dependencies.now,
    store,
  });
}

export async function runConfiguredAnalyticsCleanup(
  dependencies: Readonly<{
    analyticsStore?: ConversationAnalyticsStore;
    environment?: ConversationAnalyticsEnvironment & HandoffRetentionEnvironment;
    handoffStore?: HandoffStore;
    now?: () => Date;
    publicWriteStore?: PublicWriteAdmissionStore;
  }> = {},
) {
  const storage = await import("@/outcomes/storage-runtime");
  const [analyticsStore, publicWriteStore, handoffStore] = await Promise.all([
    dependencies.analyticsStore ?? storage.getConfiguredConversationAnalyticsStore(),
    dependencies.publicWriteStore ?? storage.getConfiguredPublicWriteAdmissionStore(),
    dependencies.handoffStore ??
      import("@/handoff/storage-runtime").then(({ getConfiguredHandoffStore }) =>
        getConfiguredHandoffStore(),
      ),
  ]);
  const now = dependencies.now ?? (() => new Date());
  const cleanedAt = safeNow(now);
  const handoffRetentionDays = configuredHandoffRetentionDays(
    {
      OPAS_HANDOFF_RETENTION_DAYS:
        dependencies.environment?.OPAS_HANDOFF_RETENTION_DAYS ??
        (typeof process.env.OPAS_HANDOFF_RETENTION_DAYS === "string"
          ? process.env.OPAS_HANDOFF_RETENTION_DAYS
          : undefined),
    },
  );
  if (handoffRetentionDays === null) {
    throw new Error("Support handoff retention is unavailable");
  }
  const handoffCreatedBefore = handoffRetentionStartedAt(
    cleanedAt,
    handoffRetentionDays,
  );
  const runtime = createConversationAnalyticsRuntime({
    environment: selectedEnvironment(dependencies.environment),
    now: () => cleanedAt,
    store: analyticsStore,
  });
  let conversations = 0;
  let handoffs = 0;
  let publicWrites = 0;
  let batches = 0;
  while (batches < maximumCleanupBatches) {
    const [conversationBatch, publicWriteBatch, handoffBatch] = await Promise.all([
      runtime.cleanup(),
      publicWriteStore.cleanup(demoIds.workspace, cleanedAt, cleanupLimit),
      handoffStore.cleanup(demoIds.workspace, handoffCreatedBefore, cleanupLimit),
    ]);
    conversations += conversationBatch;
    handoffs += handoffBatch;
    publicWrites += publicWriteBatch;
    batches += 1;
    if (
      conversationBatch < cleanupLimit &&
      publicWriteBatch < cleanupLimit &&
      handoffBatch < cleanupLimit
    ) break;
  }
  return Object.freeze({ batches, conversations, handoffs, publicWrites });
}
