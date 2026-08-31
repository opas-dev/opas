// ABOUTME: Wires generation and current-evidence retrieval into the deployment answer service.
// ABOUTME: Uses hybrid search only when query and persisted embedding metadata match exactly.
import {
  createEmbeddingAdapter,
  type EmbeddingAdapterConfiguration,
  type EmbeddingEnvironment,
} from "@/ai/embedding-config";
import type {
  EmbeddingAdapter,
  EmbeddingMetadata,
  WorkersAiEmbeddingBinding,
} from "@/ai/embeddings";
import {
  createGenerationAdapter,
  generationUsesWorkersAiBinding,
  generationPublicMetadata,
  type GenerationAdapterConfiguration,
  type GenerationEnvironment,
  type PublicGenerationMetadata,
} from "@/ai/generation-config";
import type { WorkersAiGenerationBinding } from "@/ai/generation";
import {
  AnswerError,
  createAnswerService,
  maximumAnswerOutputTokens,
  type AnswerEvidencePolicy,
  type AnswerService,
} from "@/answers/answer";
import {
  createAnswerAdmissionPolicy,
  createAnswerInferenceAdmission,
  type AnswerAdmissionEnvironment,
} from "@/answers/admission";
import {
  createAnswerGuardrails,
  type AnswerGuardrailEnvironment,
} from "@/answers/guardrails";
import type { EmbeddingGeneration, Repository } from "@/db/repository";
import { crofusionAnswerPolicyCalibrationV1 } from "@/evaluation/fixtures/crofusion-answer-policy-v1";
import {
  createEvidenceRetriever,
  createRepositoryEvidenceSource,
  type EvidenceRetrievalResult,
} from "@/search/evidence";

export const answerEvidencePolicy: Readonly<AnswerEvidencePolicy> =
  Object.freeze({
    minimumScore: 0.58,
    minimumScoreGapAcrossArticles: 0,
  });

const answerCalibration = crofusionAnswerPolicyCalibrationV1;

export const answerEvidencePolicyCalibration = Object.freeze({
  fixtureId: answerCalibration.id,
  sourceContentHash: answerCalibration.sourceContentHash,
  provenance: answerCalibration.provenance,
  embeddingProvider: answerCalibration.embeddingProvider,
  embeddingModel: answerCalibration.embeddingModel,
  requiredAnswerCount: answerCalibration.answerable.length,
  unsupportedCount: answerCalibration.unsupported.length,
  conflictingCount: answerCalibration.conflictCanaries.length,
  requiredAnswerScoreFloor: Math.min(
    ...answerCalibration.answerable.map(([, score]) => score),
  ),
  unsupportedScoreCeiling: Math.max(
    ...answerCalibration.unsupported.map(([, score]) => score),
  ),
  minimumScoreGuard: answerEvidencePolicy.minimumScore,
  conflictingArticleGapCeiling: Math.max(
    ...answerCalibration.conflictCanaries.map(([, , gap]) => gap),
  ),
  conflictingArticleGapGuard:
    answerEvidencePolicy.minimumScoreGapAcrossArticles,
  unsupportedResolution: "generation-abstention" as const,
  conflictingResolution: "generation-abstention" as const,
  designPartnerCalibration: "complete" as const,
});

export type AnswerRuntimeEnvironment = GenerationEnvironment &
  EmbeddingEnvironment &
  AnswerGuardrailEnvironment &
  AnswerAdmissionEnvironment;

export type AnswerRuntime = Readonly<{
  metadata: PublicGenerationMetadata;
  service: AnswerService;
}>;

type WorkersAiBinding = WorkersAiEmbeddingBinding &
  WorkersAiGenerationBinding;

export type AnswerRuntimeDependencies = {
  environment?: AnswerRuntimeEnvironment;
  fetch?: typeof fetch;
  workersAiBinding?: WorkersAiBinding;
  createEmbeddingAdapter?: (
    configuration: EmbeddingAdapterConfiguration,
  ) => Promise<EmbeddingAdapter>;
  createGenerationAdapter?: (
    configuration: GenerationAdapterConfiguration,
  ) => ReturnType<typeof createGenerationAdapter>;
  getRepository?: () => Promise<Repository>;
  getWorkersAiBinding?: () => Promise<WorkersAiBinding | undefined>;
};

export type RetainedAnswerRuntimeDependencies = Pick<
  AnswerRuntimeDependencies,
  | "createGenerationAdapter"
  | "environment"
  | "fetch"
  | "getRepository"
  | "getWorkersAiBinding"
  | "workersAiBinding"
>;

function exactEmbeddingMetadata(
  generation: EmbeddingGeneration | null,
  metadata: EmbeddingMetadata,
) {
  return (
    generation?.status === "active" &&
    generation.provider === metadata.provider &&
    generation.model === metadata.model &&
    generation.dimension === metadata.dimension &&
    generation.configurationHash === metadata.configurationHash
  );
}

function usableQueryVector(value: unknown, dimension: number) {
  if (
    !Array.isArray(value) ||
    value.length !== dimension ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return null;
  }
  let squaredMagnitude = 0;
  for (const entry of value) squaredMagnitude += entry * entry;
  return Number.isFinite(squaredMagnitude) && squaredMagnitude > 0
    ? (value as readonly number[])
    : null;
}

async function cloudflareWorkersAiBinding() {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext();
  return (env as { AI?: WorkersAiBinding }).AI;
}

async function selectedRepository() {
  const { getRepository } = await import("@/db");
  return getRepository();
}

async function optionalEmbeddingAdapter(
  configuration: EmbeddingAdapterConfiguration,
  factory: AnswerRuntimeDependencies["createEmbeddingAdapter"],
) {
  try {
    return await (factory ?? createEmbeddingAdapter)(configuration);
  } catch {
    return null;
  }
}

function cancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new AnswerError("cancelled", "Answer request was cancelled");
  }
}

async function interruptible<T>(operation: Promise<T>, signal?: AbortSignal) {
  if (!signal) return operation;
  cancelled(signal);
  let abort: () => void = () => {};
  const interruption = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(new AnswerError("cancelled", "Answer request was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, interruption]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function createConfiguredAnswerRuntime(
  dependencies: AnswerRuntimeDependencies = {},
): Promise<AnswerRuntime> {
  const environment =
    dependencies.environment ?? (process.env as AnswerRuntimeEnvironment);
  const guardrails = createAnswerGuardrails(
    environment.OPAS_ANSWER_TOPIC_GUARDRAILS === ""
      ? undefined
      : environment.OPAS_ANSWER_TOPIC_GUARDRAILS,
  );
  if (guardrails.status === "unavailable") {
    throw new AnswerError("configuration", "Answer guardrails are unavailable");
  }
  const admissionPolicy = createAnswerAdmissionPolicy(
    environment,
    maximumAnswerOutputTokens,
  );
  const workersAiBinding =
    generationUsesWorkersAiBinding(environment)
      ? dependencies.workersAiBinding ??
        (await (dependencies.getWorkersAiBinding ??
          cloudflareWorkersAiBinding)())
      : undefined;
  const generation = (
    dependencies.createGenerationAdapter ?? createGenerationAdapter
  )({
    environment,
    fetch: dependencies.fetch,
    workersAiBinding,
  });
  const [repository, queryEmbedding] = await Promise.all([
    (dependencies.getRepository ?? selectedRepository)(),
    optionalEmbeddingAdapter(
      {
        environment,
        fetch: dependencies.fetch,
        workersAiBinding,
      },
      dependencies.createEmbeddingAdapter,
    ),
  ]);
  const retrieveEvidence = createEvidenceRetriever(
    createRepositoryEvidenceSource(repository),
  );

  const service = createAnswerService({
    admission: createAnswerInferenceAdmission({
      policy: admissionPolicy,
      repository,
    }),
    evidencePolicy: answerEvidencePolicy,
    generation,
    guardrails,
    async retriever(request) {
      cancelled(request.signal);
      let queryVector: readonly number[] | null = null;

      if (queryEmbedding) {
        try {
          const activeGeneration =
            await interruptible(
              repository.getActiveEmbeddingGeneration(request.workspaceId),
              request.signal,
            );
          cancelled(request.signal);
          if (exactEmbeddingMetadata(activeGeneration, queryEmbedding.metadata)) {
            const batch = await interruptible(
              queryEmbedding.embed([request.query]),
              request.signal,
            );
            cancelled(request.signal);
            if (exactEmbeddingMetadata(activeGeneration, batch.metadata)) {
              queryVector = usableQueryVector(
                batch.vectors[0],
                activeGeneration!.dimension,
              );
            }
          }
        } catch {
          cancelled(request.signal);
          queryVector = null;
        }
      }

      return interruptible(
        retrieveEvidence({
          workspaceId: request.workspaceId,
          query: request.query,
          mode: queryVector ? "hybrid" : "lexical",
          ...(queryVector ? { queryVector } : {}),
          topK: request.topK,
        }),
        request.signal,
      );
    },
  });

  return Object.freeze({
    metadata: generationPublicMetadata(generation),
    service,
  });
}

export async function createConfiguredRetainedAnswerRuntime(
  evidence: readonly EvidenceRetrievalResult[],
  dependencies: RetainedAnswerRuntimeDependencies = {},
): Promise<AnswerRuntime> {
  if (!Array.isArray(evidence)) {
    throw new AnswerError("invalid-evidence", "Retained evidence is invalid");
  }
  const environment =
    dependencies.environment ?? (process.env as AnswerRuntimeEnvironment);
  const guardrails = createAnswerGuardrails(
    environment.OPAS_ANSWER_TOPIC_GUARDRAILS === ""
      ? undefined
      : environment.OPAS_ANSWER_TOPIC_GUARDRAILS,
  );
  if (guardrails.status === "unavailable") {
    throw new AnswerError("configuration", "Answer guardrails are unavailable");
  }
  const admissionPolicy = createAnswerAdmissionPolicy(
    environment,
    maximumAnswerOutputTokens,
  );
  const workersAiBinding = generationUsesWorkersAiBinding(environment)
    ? dependencies.workersAiBinding ??
      (await (dependencies.getWorkersAiBinding ?? cloudflareWorkersAiBinding)())
    : undefined;
  const generation = (
    dependencies.createGenerationAdapter ?? createGenerationAdapter
  )({
    environment,
    fetch: dependencies.fetch,
    workersAiBinding,
  });
  const repository = await (dependencies.getRepository ?? selectedRepository)();
  const retainedEvidence = Object.freeze(
    evidence.map((result) =>
      Object.freeze({
        ...result,
        headingPath: Object.freeze([...result.headingPath]),
        sourceLineRange: Object.freeze({ ...result.sourceLineRange }),
      }),
    ),
  );
  const service = createAnswerService({
    admission: createAnswerInferenceAdmission({
      policy: admissionPolicy,
      repository,
    }),
    evidencePolicy: answerEvidencePolicy,
    generation,
    guardrails,
    async retriever() {
      return retainedEvidence;
    },
  });
  return Object.freeze({
    metadata: generationPublicMetadata(generation),
    service,
  });
}
