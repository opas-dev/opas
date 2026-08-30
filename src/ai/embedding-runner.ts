// ABOUTME: Drains configured embedding jobs within fixed job and wall-clock budgets.
// ABOUTME: Initializes missing evidence before provider selection and exposes only redacted summaries.
import { createEmbeddingAdapter } from "@/ai/embedding-config";
import {
  initializeMissingArticleEvidence,
  type ArticleEvidenceInitializationRepository,
} from "@/content/article-evidence-initialization";
import {
  EmbeddingError,
  type EmbeddingAdapter,
  type WorkersAiEmbeddingBinding,
} from "@/ai/embeddings";
import {
  runEmbeddingWorker,
  type EmbeddingWorkerRepository,
  type EmbeddingWorkerResult,
} from "@/ai/embedding-worker";
import { demoIds } from "@/db/demo";

export type EmbeddingRuntimeEnvironment = {
  OPAS_DATABASE_DRIVER?: string;
  OPAS_EMBEDDING_API_KEY?: string;
  OPAS_EMBEDDING_DIMENSION?: string;
  OPAS_EMBEDDING_DIMENSIONS_PARAMETER?: string;
  OPAS_EMBEDDING_ENDPOINT?: string;
  OPAS_EMBEDDING_MODEL?: string;
  OPAS_SITE_URL?: string;
};

const defaultMaximumJobs = 100;
const defaultMaximumRuntimeMilliseconds = 50_000;
const hardMaximumJobs = 100;
const hardMaximumRuntimeMilliseconds = 55_000;

export type EmbeddingRecoverySummary = {
  status:
    | EmbeddingWorkerResult["status"]
    | "budget-exhausted"
    | "disabled";
  processedJobCount: number;
  embeddedChunkCount: number;
  activated: boolean;
};

export type EmbeddingRuntimeFailureDetails = {
  type: "EmbeddingError" | "Error" | "UnknownError";
  category?: EmbeddingError["category"];
};

export type EmbeddingRunnerDependencies = {
  environment: EmbeddingRuntimeEnvironment;
  workersAiBinding?: WorkersAiEmbeddingBinding;
  createAdapter?: typeof createEmbeddingAdapter;
  createLeaseToken?: () => string;
  getRepository: () => Promise<
    EmbeddingWorkerRepository & ArticleEvidenceInitializationRepository
  >;
  maximumJobs?: number;
  maximumRuntimeMilliseconds?: number;
  runtimeMilliseconds?: () => number;
  runWorker?: typeof runEmbeddingWorker;
};

function configuredNonCloudflareProvider(
  environment: EmbeddingRuntimeEnvironment,
) {
  return (
    environment.OPAS_EMBEDDING_ENDPOINT?.trim() !== "" &&
    environment.OPAS_EMBEDDING_ENDPOINT !== undefined &&
    environment.OPAS_EMBEDDING_MODEL?.trim() !== "" &&
    environment.OPAS_EMBEDDING_MODEL !== undefined &&
    environment.OPAS_EMBEDDING_DIMENSION?.trim() !== "" &&
    environment.OPAS_EMBEDDING_DIMENSION !== undefined
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new EmbeddingError(
      "configuration",
      "Embedding recovery budget is invalid",
    );
  }

  return value;
}

function recoverySummary(input: {
  status: EmbeddingRecoverySummary["status"];
  processedJobCount: number;
  embeddedChunkCount: number;
  activated: boolean;
}): EmbeddingRecoverySummary {
  return Object.freeze({
    status: input.status,
    processedJobCount: input.processedJobCount,
    embeddedChunkCount: input.embeddedChunkCount,
    activated: input.activated,
  });
}

export function embeddingRuntimeFailureDetails(
  error: unknown,
): EmbeddingRuntimeFailureDetails {
  if (error instanceof EmbeddingError) {
    return Object.freeze({
      type: "EmbeddingError",
      category: error.category,
    });
  }

  if (error instanceof Error) {
    return Object.freeze({ type: "Error" });
  }

  return Object.freeze({ type: "UnknownError" });
}

export async function runEmbeddingWorkerBatch(
  dependencies: EmbeddingRunnerDependencies,
): Promise<EmbeddingRecoverySummary> {
  const databaseDriver =
    dependencies.environment.OPAS_DATABASE_DRIVER ?? "postgres";
  const repository = await dependencies.getRepository();
  await initializeMissingArticleEvidence({
    ...(dependencies.environment.OPAS_SITE_URL === undefined
      ? {}
      : { configuredSiteUrl: dependencies.environment.OPAS_SITE_URL }),
    repository,
    workspaceId: demoIds.workspace,
  });

  if (
    (databaseDriver === "postgres" || databaseDriver === "neon") &&
    !configuredNonCloudflareProvider(dependencies.environment)
  ) {
    return recoverySummary({
      status: "disabled",
      processedJobCount: 0,
      embeddedChunkCount: 0,
      activated: false,
    });
  }

  const adapter: EmbeddingAdapter = await (
    dependencies.createAdapter ?? createEmbeddingAdapter
  )({
    environment: dependencies.environment,
    workersAiBinding: dependencies.workersAiBinding,
  });
  const maximumJobs = boundedInteger(
    dependencies.maximumJobs,
    defaultMaximumJobs,
    hardMaximumJobs,
  );
  const maximumRuntimeMilliseconds = boundedInteger(
    dependencies.maximumRuntimeMilliseconds,
    defaultMaximumRuntimeMilliseconds,
    hardMaximumRuntimeMilliseconds,
  );
  const runtimeMilliseconds = dependencies.runtimeMilliseconds ?? Date.now;
  const startedAt = runtimeMilliseconds();
  let processedJobCount = 0;
  let embeddedChunkCount = 0;
  let activated = false;

  while (
    processedJobCount < maximumJobs &&
    runtimeMilliseconds() - startedAt < maximumRuntimeMilliseconds
  ) {
    const result = await (dependencies.runWorker ?? runEmbeddingWorker)({
      adapter,
      leaseToken: (
        dependencies.createLeaseToken ?? (() => crypto.randomUUID())
      )(),
      repository,
      workspaceId: demoIds.workspace,
    });
    embeddedChunkCount += result.embeddedChunkCount;
    activated ||= result.activated;

    if (result.status === "completed" || result.jobId !== undefined) {
      processedJobCount += 1;
    }

    if (result.status !== "completed") {
      return recoverySummary({
        status: result.status,
        processedJobCount,
        embeddedChunkCount,
        activated,
      });
    }
  }

  return recoverySummary({
    status: "budget-exhausted",
    processedJobCount,
    embeddedChunkCount,
    activated,
  });
}
