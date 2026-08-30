// ABOUTME: Connects durable handoff admission and escalation outcomes to deployment stores.
// ABOUTME: Keeps delivery fail-closed while analytics updates remain best effort.
import { demoIds } from "@/db/demo";
import { createHandoffWriteAdmission } from "@/outcomes/admission";
import { outcomeFailureDetails, recordConfiguredPublicOutcome } from "@/outcomes/public";
import { getConfiguredPublicWriteAdmissionStore } from "@/outcomes/storage-runtime";

export async function reserveConfiguredHandoffWrite(id: string) {
  const admission = createHandoffWriteAdmission({
    environment: {
      OPAS_HANDOFF_DAILY_LIMIT: process.env.OPAS_HANDOFF_DAILY_LIMIT,
    },
    store: await getConfiguredPublicWriteAdmissionStore(),
    workspaceId: demoIds.workspace,
  });
  return admission.reserve(id);
}

export async function recordConfiguredEscalation(id: string) {
  try {
    await recordConfiguredPublicOutcome(id, "escalated", "support-handoff");
  } catch (error) {
    console.error(
      "Support escalation analytics persistence failed.",
      outcomeFailureDetails(error),
    );
  }
}
