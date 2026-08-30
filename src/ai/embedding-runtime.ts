// ABOUTME: Resolves request-scoped deployment bindings for the portable embedding runner.
// ABOUTME: Keeps Next.js repository access out of the standalone Cloudflare scheduled entry point.
import type { WorkersAiEmbeddingBinding } from "@/ai/embeddings";
import {
  embeddingRuntimeFailureDetails,
  runEmbeddingWorkerBatch,
  type EmbeddingRecoverySummary,
  type EmbeddingRunnerDependencies,
  type EmbeddingRuntimeFailureDetails,
  type EmbeddingRuntimeEnvironment,
} from "@/ai/embedding-runner";
import type { EmbeddingWorkerRepository } from "@/ai/embedding-worker";
import type { ArticleEvidenceInitializationRepository } from "@/content/article-evidence-initialization";

type EmbeddingRuntimeDependencies = Omit<
  EmbeddingRunnerDependencies,
  "environment" | "getRepository" | "workersAiBinding"
> & {
  environment?: EmbeddingRuntimeEnvironment;
  getRepository?: () => Promise<
    EmbeddingWorkerRepository & ArticleEvidenceInitializationRepository
  >;
  getWorkersAiBinding?: () => Promise<WorkersAiEmbeddingBinding | undefined>;
  repository?: EmbeddingWorkerRepository & ArticleEvidenceInitializationRepository;
  workersAiBinding?: WorkersAiEmbeddingBinding;
};

async function selectedRepository() {
  const { getRepository } = await import("@/db");
  return getRepository();
}

async function cloudflareWorkersAiBinding() {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();
  return (env as { AI?: WorkersAiEmbeddingBinding }).AI;
}

export { embeddingRuntimeFailureDetails };
export type { EmbeddingRecoverySummary, EmbeddingRuntimeFailureDetails };

export async function runConfiguredEmbeddingWorker(
  dependencies: EmbeddingRuntimeDependencies = {},
): Promise<EmbeddingRecoverySummary> {
  const environment = dependencies.environment ?? process.env;
  const databaseDriver = environment.OPAS_DATABASE_DRIVER ?? "postgres";
  const workersAiBinding =
    databaseDriver === "d1"
      ? dependencies.workersAiBinding ??
        (await (dependencies.getWorkersAiBinding ??
          cloudflareWorkersAiBinding)())
      : undefined;

  return runEmbeddingWorkerBatch({
    environment,
    workersAiBinding,
    createAdapter: dependencies.createAdapter,
    createLeaseToken: dependencies.createLeaseToken,
    getRepository:
      dependencies.repository === undefined
        ? dependencies.getRepository ?? selectedRepository
        : async () => dependencies.repository as EmbeddingWorkerRepository &
            ArticleEvidenceInitializationRepository,
    maximumJobs: dependencies.maximumJobs,
    maximumRuntimeMilliseconds: dependencies.maximumRuntimeMilliseconds,
    runtimeMilliseconds: dependencies.runtimeMilliseconds,
    runWorker: dependencies.runWorker,
  });
}
