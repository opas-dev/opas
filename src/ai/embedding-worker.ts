// ABOUTME: Orchestrates leased embedding jobs without depending on a database or runtime.
// ABOUTME: Persists exact provider output in bounded batches and activates only complete generations.
import {
  EmbeddingError,
  type EmbeddingAdapter,
  type EmbeddingErrorCategory,
  type EmbeddingMetadata,
} from "@/ai/embeddings";

export const embeddingPersistenceMaximumUtf8Bytes = 1_500_000;

const embeddingJobLeaseMilliseconds = 90_000;
const embeddingRetryDelayMilliseconds = [5_000, 30_000, 120_000] as const;
const utf8Encoder = new TextEncoder();

type EmbeddingIdentity = Pick<
  EmbeddingMetadata,
  "provider" | "model" | "dimension" | "configurationHash"
>;

export type EmbeddingWorkerGeneration = EmbeddingIdentity & {
  id: string;
  workspaceId: string;
  status: "active" | "building" | "failed" | "retired";
};

export type EmbeddingWorkerJob = {
  id: string;
  attempts: number;
  maximumAttempts: number;
  embeddingGenerationId: string;
};

export type EmbeddingWorkerChunk = {
  id: string;
  contentHash: string;
  embeddingInputHash: string;
  embeddingText: string;
};

export type EmbeddingWorkerWork = {
  job: EmbeddingWorkerJob;
  generation: EmbeddingWorkerGeneration;
  chunks: readonly EmbeddingWorkerChunk[];
  completedChunkCount: number;
  totalChunkCount: number;
};

export type EmbeddingWorkerSubmission = {
  chunkId: string;
  contentHash: string;
  embeddingInputHash: string;
  vector: readonly number[];
};

export interface EmbeddingWorkerRepository {
  reconcileEmbeddingGeneration(input: {
    workspaceId: string;
    metadata: EmbeddingMetadata;
    reconciledAt: Date;
  }): Promise<EmbeddingWorkerGeneration>;
  claimEmbeddingJob(input: {
    workspaceId: string;
    embeddingGenerationId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
    leaseToken: string;
  }): Promise<EmbeddingWorkerJob | null>;
  getEmbeddingJobWork(input: {
    workspaceId: string;
    id: string;
    leaseToken: string;
    checkedAt: Date;
  }): Promise<EmbeddingWorkerWork | null>;
  saveEmbeddingJobBatch(input: {
    workspaceId: string;
    id: string;
    leaseToken: string;
    embeddingGenerationId: string;
    embeddings: readonly EmbeddingWorkerSubmission[];
    checkedAt: Date;
  }): Promise<boolean>;
  checkpointEmbeddingJob(input: {
    workspaceId: string;
    id: string;
    leaseToken: string;
    completedChunkCount: number;
    checkedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  completeEmbeddingJob(input: {
    workspaceId: string;
    id: string;
    leaseToken: string;
    checkedAt: Date;
  }): Promise<boolean>;
  retryEmbeddingJob(input: {
    workspaceId: string;
    id: string;
    leaseToken: string;
    checkedAt: Date;
    availableAt: Date;
    errorCode: EmbeddingErrorCategory;
  }): Promise<boolean>;
  failEmbeddingJob(input: {
    workspaceId: string;
    id: string;
    leaseToken: string;
    checkedAt: Date;
    errorCode: EmbeddingErrorCategory;
  }): Promise<boolean>;
  activateEmbeddingGeneration(input: {
    workspaceId: string;
    embeddingGenerationId: string;
    activatedAt: Date;
    metadata: EmbeddingMetadata;
  }): Promise<boolean>;
}

export type EmbeddingWorkerResult = {
  status:
    | "completed"
    | "failed"
    | "idle"
    | "lost-lease"
    | "retry-scheduled";
  generationId: string;
  jobId?: string;
  embeddedChunkCount: number;
  activated: boolean;
};

export type EmbeddingWorkerOptions = {
  adapter: EmbeddingAdapter;
  clock?: () => Date;
  leaseToken: string;
  repository: EmbeddingWorkerRepository;
  workspaceId: string;
};

function exactIdentity(
  expected: EmbeddingIdentity,
  received: EmbeddingIdentity,
) {
  return (
    expected.provider === received.provider &&
    expected.model === received.model &&
    expected.dimension === received.dimension &&
    expected.configurationHash === received.configurationHash
  );
}

function providerInputBatch(
  chunks: readonly EmbeddingWorkerChunk[],
  adapter: EmbeddingAdapter,
) {
  const selected: EmbeddingWorkerChunk[] = [];
  let batchUtf8Bytes = 0;

  for (const chunk of chunks) {
    const inputUtf8Bytes = utf8Encoder.encode(chunk.embeddingText).byteLength;

    if (
      selected.length === 0 &&
      inputUtf8Bytes > adapter.limits.maximumInputUtf8Bytes
    ) {
      throw new EmbeddingError(
        "invalid-input",
        "Embedding job contains an oversized text value",
      );
    }

    if (
      selected.length >= adapter.limits.maximumBatchSize ||
      batchUtf8Bytes + inputUtf8Bytes >
        adapter.limits.maximumBatchInputUtf8Bytes
    ) {
      break;
    }

    selected.push(chunk);
    batchUtf8Bytes += inputUtf8Bytes;
  }

  return selected;
}

function persistenceBatches(
  submissions: readonly EmbeddingWorkerSubmission[],
) {
  const batches: EmbeddingWorkerSubmission[][] = [];
  let current: EmbeddingWorkerSubmission[] = [];

  for (const submission of submissions) {
    const candidate = [...current, submission];
    const candidateUtf8Bytes = utf8Encoder.encode(
      JSON.stringify(candidate),
    ).byteLength;

    if (
      candidateUtf8Bytes > embeddingPersistenceMaximumUtf8Bytes &&
      current.length > 0
    ) {
      batches.push(current);
      current = [submission];
    } else {
      current = candidate;
    }

    if (
      current.length === 1 &&
      utf8Encoder.encode(JSON.stringify(current)).byteLength >
        embeddingPersistenceMaximumUtf8Bytes
    ) {
      throw new EmbeddingError(
        "invalid-response",
        "Embedding vector exceeds the portable persistence size",
      );
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function providerError(error: unknown) {
  return error instanceof EmbeddingError
    ? error
    : new EmbeddingError(
        "provider-unavailable",
        "Embedding provider request failed",
      );
}

function retryDelay(attempts: number) {
  return embeddingRetryDelayMilliseconds[
    Math.min(
      Math.max(attempts - 1, 0),
      embeddingRetryDelayMilliseconds.length - 1,
    )
  ];
}

async function recordJobFailure(input: {
  clock: () => Date;
  embeddedChunkCount: number;
  error: EmbeddingError;
  generationId: string;
  job: EmbeddingWorkerJob;
  leaseToken: string;
  repository: EmbeddingWorkerRepository;
  workspaceId: string;
}): Promise<EmbeddingWorkerResult> {
  const checkedAt = input.clock();
  const common = {
    workspaceId: input.workspaceId,
    id: input.job.id,
    leaseToken: input.leaseToken,
    checkedAt,
    errorCode: input.error.category,
  };

  if (input.error.retryable && input.job.attempts < input.job.maximumAttempts) {
    const updated = await input.repository.retryEmbeddingJob({
      ...common,
      availableAt: new Date(checkedAt.getTime() + retryDelay(input.job.attempts)),
    });
    return {
      status: updated ? "retry-scheduled" : "lost-lease",
      generationId: input.generationId,
      jobId: input.job.id,
      embeddedChunkCount: input.embeddedChunkCount,
      activated: false,
    };
  }

  const updated = await input.repository.failEmbeddingJob(common);
  return {
    status: updated ? "failed" : "lost-lease",
    generationId: input.generationId,
    jobId: input.job.id,
    embeddedChunkCount: input.embeddedChunkCount,
    activated: false,
  };
}

function lostLeaseResult(
  generationId: string,
  jobId: string,
  embeddedChunkCount: number,
): EmbeddingWorkerResult {
  return {
    status: "lost-lease",
    generationId,
    jobId,
    embeddedChunkCount,
    activated: false,
  };
}

export async function runEmbeddingWorker(
  options: EmbeddingWorkerOptions,
): Promise<EmbeddingWorkerResult> {
  const clock = options.clock ?? (() => new Date());
  const reconciledAt = clock();
  const generation = await options.repository.reconcileEmbeddingGeneration({
    workspaceId: options.workspaceId,
    metadata: options.adapter.metadata,
    reconciledAt,
  });

  if (
    generation.workspaceId !== options.workspaceId ||
    !exactIdentity(options.adapter.metadata, generation)
  ) {
    throw new EmbeddingError(
      "configuration",
      "Embedding generation does not match the configured provider",
    );
  }

  const job = await options.repository.claimEmbeddingJob({
    workspaceId: options.workspaceId,
    embeddingGenerationId: generation.id,
    claimedAt: reconciledAt,
    leaseExpiresAt: new Date(
      reconciledAt.getTime() + embeddingJobLeaseMilliseconds,
    ),
    leaseToken: options.leaseToken,
  });

  if (job === null) {
    const activatedAt = clock();
    const activated = await options.repository.activateEmbeddingGeneration({
      workspaceId: options.workspaceId,
      embeddingGenerationId: generation.id,
      activatedAt,
      metadata: options.adapter.metadata,
    });
    return {
      status: "idle",
      generationId: generation.id,
      embeddedChunkCount: 0,
      activated,
    };
  }

  let embeddedChunkCount = 0;

  while (true) {
    const checkedAt = clock();
    const work = await options.repository.getEmbeddingJobWork({
      workspaceId: options.workspaceId,
      id: job.id,
      leaseToken: options.leaseToken,
      checkedAt,
    });

    if (work === null) {
      return lostLeaseResult(generation.id, job.id, embeddedChunkCount);
    }

    if (
      work.job.id !== job.id ||
      work.job.embeddingGenerationId !== generation.id ||
      work.generation.id !== generation.id ||
      work.generation.workspaceId !== options.workspaceId ||
      !exactIdentity(options.adapter.metadata, work.generation) ||
      !Number.isSafeInteger(work.completedChunkCount) ||
      !Number.isSafeInteger(work.totalChunkCount) ||
      work.completedChunkCount < 0 ||
      work.totalChunkCount < work.completedChunkCount
    ) {
      return recordJobFailure({
        clock,
        embeddedChunkCount,
        error: new EmbeddingError(
          "invalid-response",
          "Embedding job state is inconsistent",
        ),
        generationId: generation.id,
        job,
        leaseToken: options.leaseToken,
        repository: options.repository,
        workspaceId: options.workspaceId,
      });
    }

    if (work.chunks.length === 0) {
      if (work.completedChunkCount !== work.totalChunkCount) {
        return recordJobFailure({
          clock,
          embeddedChunkCount,
          error: new EmbeddingError(
            "invalid-response",
            "Embedding job coverage is incomplete",
          ),
          generationId: generation.id,
          job,
          leaseToken: options.leaseToken,
          repository: options.repository,
          workspaceId: options.workspaceId,
        });
      }

      const completedAt = clock();
      const completed = await options.repository.completeEmbeddingJob({
        workspaceId: options.workspaceId,
        id: job.id,
        leaseToken: options.leaseToken,
        checkedAt: completedAt,
      });

      if (!completed) {
        return lostLeaseResult(generation.id, job.id, embeddedChunkCount);
      }

      const activatedAt = clock();
      const activated = await options.repository.activateEmbeddingGeneration({
        workspaceId: options.workspaceId,
        embeddingGenerationId: generation.id,
        activatedAt,
        metadata: options.adapter.metadata,
      });
      return {
        status: "completed",
        generationId: generation.id,
        jobId: job.id,
        embeddedChunkCount,
        activated,
      };
    }

    let selectedChunks: readonly EmbeddingWorkerChunk[];
    let submissions: readonly EmbeddingWorkerSubmission[];

    try {
      selectedChunks = providerInputBatch(work.chunks, options.adapter);
      const batch = await options.adapter.embed(
        selectedChunks.map((chunk) => chunk.embeddingText),
      );

      if (
        !exactIdentity(options.adapter.metadata, batch.metadata) ||
        batch.vectors.length !== selectedChunks.length
      ) {
        throw new EmbeddingError(
          "invalid-response",
          "Embedding provider returned mismatched metadata or vector count",
        );
      }

      submissions = selectedChunks.map((chunk, index) => ({
        chunkId: chunk.id,
        contentHash: chunk.contentHash,
        embeddingInputHash: chunk.embeddingInputHash,
        vector: batch.vectors[index] as readonly number[],
      }));
    } catch (error) {
      return recordJobFailure({
        clock,
        embeddedChunkCount,
        error: providerError(error),
        generationId: generation.id,
        job,
        leaseToken: options.leaseToken,
        repository: options.repository,
        workspaceId: options.workspaceId,
      });
    }

    let batches: readonly (readonly EmbeddingWorkerSubmission[])[];

    try {
      batches = persistenceBatches(submissions);
    } catch (error) {
      return recordJobFailure({
        clock,
        embeddedChunkCount,
        error: providerError(error),
        generationId: generation.id,
        job,
        leaseToken: options.leaseToken,
        repository: options.repository,
        workspaceId: options.workspaceId,
      });
    }

    for (const embeddings of batches) {
      const saved = await options.repository.saveEmbeddingJobBatch({
        workspaceId: options.workspaceId,
        id: job.id,
        leaseToken: options.leaseToken,
        embeddingGenerationId: generation.id,
        embeddings,
        checkedAt: clock(),
      });

      if (!saved) {
        return lostLeaseResult(generation.id, job.id, embeddedChunkCount);
      }
    }

    embeddedChunkCount += selectedChunks.length;
    const checkpointedAt = clock();
    const checkpointed = await options.repository.checkpointEmbeddingJob({
      workspaceId: options.workspaceId,
      id: job.id,
      leaseToken: options.leaseToken,
      completedChunkCount:
        work.completedChunkCount + selectedChunks.length,
      checkedAt: checkpointedAt,
      leaseExpiresAt: new Date(
        checkpointedAt.getTime() + embeddingJobLeaseMilliseconds,
      ),
    });

    if (!checkpointed) {
      return lostLeaseResult(generation.id, job.id, embeddedChunkCount);
    }
  }
}
