// ABOUTME: Schedules embedding recovery after a successful publication response is released.
// ABOUTME: Contains provider failures so publishing remains independent from inference availability.
import { after } from "next/server";

import {
  embeddingRuntimeFailureDetails,
  runConfiguredEmbeddingWorker,
  type EmbeddingRecoverySummary,
  type EmbeddingRuntimeFailureDetails,
} from "@/ai/embedding-runtime";

type EmbeddingRecoveryScheduler = (
  callback: () => void | Promise<void>,
) => void;

type EmbeddingSchedulingDependencies = {
  schedule?: EmbeddingRecoveryScheduler;
  recover?: () => Promise<EmbeddingRecoverySummary>;
  reportFailure?: (details: EmbeddingRuntimeFailureDetails) => void;
};

function reportEmbeddingRecoveryFailure(
  details: EmbeddingRuntimeFailureDetails,
) {
  console.error("Post-commit embedding recovery failed.", details);
}

export function scheduleEmbeddingRecovery(
  dependencies: EmbeddingSchedulingDependencies = {},
) {
  const schedule = dependencies.schedule ?? after;
  const recover = dependencies.recover ?? runConfiguredEmbeddingWorker;
  const reportFailure =
    dependencies.reportFailure ?? reportEmbeddingRecoveryFailure;

  schedule(async () => {
    try {
      await recover();
    } catch (error) {
      reportFailure(embeddingRuntimeFailureDetails(error));
    }
  });
}
