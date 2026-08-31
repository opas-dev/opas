// ABOUTME: Admits and updates public conversation outcomes without exposing record existence.
// ABOUTME: Keeps requester data ephemeral and disabled analytics free of conversation rows.
import { demoIds } from "@/db/demo";
import { createOutcomeWriteAdmission } from "@/outcomes/admission";
import { createConfiguredConversationAnalyticsRuntime } from "@/outcomes/runtime";
import { getConfiguredPublicWriteAdmissionStore } from "@/outcomes/storage-runtime";

const missingRecordRetryDelaysMilliseconds = Object.freeze([50, 100, 200, 400]);

type PublicOutcomeRuntime = Awaited<
  ReturnType<typeof createConfiguredConversationAnalyticsRuntime>
>;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function reserveConfiguredOutcomeWrite() {
  const admission = createOutcomeWriteAdmission({
    store: await getConfiguredPublicWriteAdmissionStore(),
    workspaceId: demoIds.workspace,
  });
  return admission.reserve();
}

export async function recordConfiguredPublicOutcome(
  id: string,
  outcome: "abandoned" | "escalated" | "low-rated",
  reason?: string | null,
  dependencies: Readonly<{
    getRuntime?: () => Promise<PublicOutcomeRuntime>;
    wait?: (milliseconds: number) => Promise<void>;
  }> = {},
) {
  const runtime = await (
    dependencies.getRuntime ?? createConfiguredConversationAnalyticsRuntime
  )();
  if (runtime.status === "disabled") return "disabled" as const;
  if (runtime.status === "unavailable") {
    throw new Error("Conversation analytics are unavailable");
  }
  for (const delay of [0, ...missingRecordRetryDelaysMilliseconds]) {
    if (delay > 0) await (dependencies.wait ?? wait)(delay);
    if (await runtime.updateOutcome(id, outcome, reason)) {
      return "updated" as const;
    }
  }
  return "missing" as const;
}

export function outcomeFailureDetails(error: unknown) {
  return Object.freeze({
    type: error instanceof Error ? error.name : "UnknownError",
  });
}
