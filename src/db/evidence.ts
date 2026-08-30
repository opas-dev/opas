// ABOUTME: Validates portable evidence records before either database dialect stores them.
// ABOUTME: Keeps hash, generation, lease, vector, fixture, and evaluation bounds consistent.
import { embeddingPersistenceMaximumUtf8Bytes } from "@/ai/embedding-worker";
import type {
  ArticleEvidenceCommit,
  ArticleEvidenceInitialization,
  ArticleSubmission,
  ChunkEmbeddingBatch,
  EmbeddingGenerationActivation,
  EmbeddingGenerationReconciliation,
  EmbeddingGeneration,
  EmbeddingJobBatch,
  EmbeddingJobClaim,
  EmbeddingJobCheckpoint,
  EmbeddingJobCompletion,
  EmbeddingJobFailure,
  EmbeddingJobRetry,
  EmbeddingJobWorkRequest,
  EvidenceCandidateRevalidation,
  EvaluationRunCompletion,
  EvaluationRunResultsUpdate,
  EvaluationRunStart,
  SavedQuestionSet,
} from "@/db/repository";

const hashPattern = /^[a-f0-9]{64}$/u;
const identifierMaximumLength = 200;
const textMaximumLength = 500;
const evidenceChunkMaximumOrdinal = 999_999;
const evidenceCandidateMaximumCount = 20;
export const articleEvidenceInitializationMaximumCount = 20;
const questionSetMaximumQuestions = 1_000;
const questionMaximumSources = 100;
const evaluationResultsMaximumCharacters = 750_000;
export const evidenceReviewMaximumRecords = 100;
const savedQuestionClassifications = new Set([
  "answerable",
  "ambiguous",
  "unsupported",
  "stale-conflicting",
  "adversarial",
]);
const savedQuestionOutcomes = new Set(["answer", "abstain", "either"]);
const utf8Encoder = new TextEncoder();

export class EvidenceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStorageError";
  }
}

function boundedText(value: string, label: string, maximum = textMaximumLength) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new EvidenceStorageError(`${label} is invalid`);
  }
  return normalized;
}

function identifier(value: string, label: string) {
  return boundedText(value, label, identifierMaximumLength);
}

function hash(value: string, label: string) {
  if (!hashPattern.test(value)) {
    throw new EvidenceStorageError(`${label} must be a lowercase SHA-256 hash`);
  }
}

function timestamp(value: Date, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new EvidenceStorageError(`${label} is invalid`);
  }
}

export function validateEmbeddingGeneration(generation: EmbeddingGeneration) {
  identifier(generation.id, "Embedding generation ID");
  identifier(generation.workspaceId, "Workspace ID");
  boundedText(generation.provider, "Embedding provider");
  boundedText(generation.model, "Embedding model");
  hash(generation.configurationHash, "Embedding configuration hash");
  if (!Number.isInteger(generation.dimension) || generation.dimension < 1 || generation.dimension > 4_096) {
    throw new EvidenceStorageError("Embedding dimension is invalid");
  }
  if (
    generation.status !== "building" ||
    generation.activatedAt !== null ||
    generation.retiredAt !== null
  ) {
    throw new EvidenceStorageError("A created embedding generation must be building");
  }
  timestamp(generation.createdAt, "Embedding generation creation time");
}

function validateEmbeddingMetadata(metadata: {
  provider: string;
  model: string;
  dimension: number;
  configurationHash: string;
}) {
  boundedText(metadata.provider, "Embedding provider");
  boundedText(metadata.model, "Embedding model");
  hash(metadata.configurationHash, "Embedding configuration hash");
  if (
    !Number.isInteger(metadata.dimension) ||
    metadata.dimension < 1 ||
    metadata.dimension > 4_096
  ) {
    throw new EvidenceStorageError("Embedding dimension is invalid");
  }
}

export function validateEmbeddingGenerationReconciliation(
  reconciliation: EmbeddingGenerationReconciliation,
) {
  identifier(reconciliation.workspaceId, "Workspace ID");
  validateEmbeddingMetadata(reconciliation.metadata);
  timestamp(reconciliation.reconciledAt, "Embedding reconciliation time");
}

export function validateEvidenceCommit(commit: ArticleEvidenceCommit) {
  identifier(commit.workspaceId, "Workspace ID");
  identifier(commit.articleId, "Article ID");
  identifier(commit.categorySlug, "Evidence category slug");
  hash(commit.articleContentHash, "Article content hash");
  identifier(commit.job.id, "Embedding job ID");
  if (commit.job.embeddingGenerationId) {
    identifier(commit.job.embeddingGenerationId, "Embedding generation ID");
  }
  if (!Number.isInteger(commit.job.maximumAttempts) || commit.job.maximumAttempts < 1 || commit.job.maximumAttempts > 10) {
    throw new EvidenceStorageError("Embedding job attempt limit is invalid");
  }
  timestamp(commit.job.availableAt, "Embedding job availability time");

  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const chunk of commit.chunks) {
    identifier(chunk.id, "Evidence chunk ID");
    hash(chunk.contentHash, "Evidence content hash");
    hash(chunk.embeddingInputHash, "Embedding input hash");
    if (ids.has(chunk.id) || ordinals.has(chunk.ordinal)) {
      throw new EvidenceStorageError("Evidence chunks require unique IDs and ordinals");
    }
    ids.add(chunk.id);
    ordinals.add(chunk.ordinal);
    if (
      !Number.isInteger(chunk.ordinal) ||
      chunk.ordinal < 0 ||
      chunk.ordinal > evidenceChunkMaximumOrdinal
    ) {
      throw new EvidenceStorageError("Evidence chunk ordinal is invalid");
    }
    boundedText(chunk.title, "Evidence title", 1_000);
    if (!Array.isArray(chunk.headingPath) || chunk.headingPath.some((heading) => typeof heading !== "string" || !heading.trim())) {
      throw new EvidenceStorageError("Evidence heading path is invalid");
    }
    let canonicalUrl: URL;
    try {
      canonicalUrl = new URL(chunk.canonicalUrl);
    } catch {
      throw new EvidenceStorageError("Evidence canonical URL is invalid");
    }
    if (
      (canonicalUrl.protocol !== "http:" && canonicalUrl.protocol !== "https:") ||
      canonicalUrl.username ||
      canonicalUrl.password ||
      canonicalUrl.search ||
      canonicalUrl.hash
    ) {
      throw new EvidenceStorageError("Evidence canonical URL is invalid");
    }
    if (!chunk.markdown || !chunk.evidenceText || !chunk.embeddingText) {
      throw new EvidenceStorageError("Evidence chunk text is empty");
    }
    if (
      !Number.isInteger(chunk.sourceLineRange.start) ||
      !Number.isInteger(chunk.sourceLineRange.end) ||
      chunk.sourceLineRange.start < 1 ||
      chunk.sourceLineRange.end < chunk.sourceLineRange.start
    ) {
      throw new EvidenceStorageError("Evidence source line range is invalid");
    }
  }
}

export function validateArticleEvidenceInitialization(
  initialization: ArticleEvidenceInitialization,
) {
  const { article, evidence, initializedAt } = initialization;
  validateArticleEvidence(article, evidence);
  if (
    article.status !== "published" ||
    evidence.categorySlug !== article.categorySlug
  ) {
    throw new EvidenceStorageError(
      "Evidence initialization requires the matching published category",
    );
  }
  timestamp(initializedAt, "Evidence initialization time");
}

export function validateArticleEvidenceInitializationQuery(
  workspaceId: string,
  limit: number,
) {
  identifier(workspaceId, "Workspace ID");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > articleEvidenceInitializationMaximumCount
  ) {
    throw new EvidenceStorageError("Evidence initialization limit is invalid");
  }
}

export function validateArticleEvidence(
  article: ArticleSubmission,
  evidence: ArticleEvidenceCommit | null,
) {
  if (article.status === "published" && evidence === null) {
    throw new EvidenceStorageError("Published articles require prepared evidence");
  }
  if (article.status === "draft" && evidence !== null) {
    throw new EvidenceStorageError("Draft articles cannot contain published evidence");
  }
  if (!evidence) {
    return;
  }
  if (
    evidence.workspaceId !== article.workspaceId ||
    evidence.articleId !== article.id
  ) {
    throw new EvidenceStorageError(
      "Prepared evidence must belong to the saved article and workspace",
    );
  }
  validateEvidenceCommit(evidence);
}

export function validateEvidenceCandidateRevalidation(
  request: EvidenceCandidateRevalidation,
) {
  identifier(request.workspaceId, "Workspace ID");
  if (
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Array.isArray(request.candidates) ||
    request.candidates.length > evidenceCandidateMaximumCount
  ) {
    throw new EvidenceStorageError("Evidence candidate revalidation is invalid");
  }
  for (const candidate of request.candidates) {
    identifier(candidate.chunkId, "Evidence chunk ID");
    identifier(candidate.articleId, "Article ID");
    hash(candidate.articleContentHash, "Article content hash");
    hash(candidate.contentHash, "Evidence content hash");
  }
}

export function validateEmbeddingJobClaim(claim: EmbeddingJobClaim) {
  identifier(claim.workspaceId, "Workspace ID");
  identifier(claim.embeddingGenerationId, "Embedding generation ID");
  identifier(claim.leaseToken, "Embedding job lease token");
  timestamp(claim.claimedAt, "Embedding job claim time");
  timestamp(claim.leaseExpiresAt, "Embedding job lease expiry");
  if (claim.leaseExpiresAt <= claim.claimedAt) {
    throw new EvidenceStorageError("Embedding job lease must expire after it is claimed");
  }
}

export function validateEmbeddingJobCheckpoint(checkpoint: EmbeddingJobCheckpoint) {
  identifier(checkpoint.workspaceId, "Workspace ID");
  identifier(checkpoint.id, "Embedding job ID");
  identifier(checkpoint.leaseToken, "Embedding job lease token");
  timestamp(checkpoint.checkedAt, "Embedding job checkpoint time");
  timestamp(checkpoint.leaseExpiresAt, "Embedding job lease expiry");
  if (checkpoint.leaseExpiresAt <= checkpoint.checkedAt) {
    throw new EvidenceStorageError("Embedding job lease must expire after its checkpoint");
  }
  if (!Number.isInteger(checkpoint.completedChunkCount) || checkpoint.completedChunkCount < 0) {
    throw new EvidenceStorageError("Embedding job checkpoint is invalid");
  }
}

export function validateEmbeddingJobRetry(retry: EmbeddingJobRetry) {
  validateEmbeddingJobCompletion(retry);
  boundedText(retry.errorCode, "Embedding error code", 100);
  timestamp(retry.availableAt, "Embedding retry time");
  if (retry.availableAt <= retry.checkedAt) {
    throw new EvidenceStorageError("Embedding retry time must be in the future");
  }
}

export function validateEmbeddingJobCompletion(completion: EmbeddingJobCompletion) {
  identifier(completion.workspaceId, "Workspace ID");
  identifier(completion.id, "Embedding job ID");
  identifier(completion.leaseToken, "Embedding job lease token");
  timestamp(completion.checkedAt, "Embedding job completion time");
}

export function validateEmbeddingJobFailure(failure: EmbeddingJobFailure) {
  validateEmbeddingJobCompletion(failure);
  boundedText(failure.errorCode, "Embedding error code", 100);
}

export function validateEmbeddingJobWorkRequest(request: EmbeddingJobWorkRequest) {
  validateEmbeddingJobCompletion(request);
}

export function validateEmbeddingJobBatch(batch: EmbeddingJobBatch, dimension: number) {
  validateEmbeddingJobCompletion(batch);
  identifier(batch.embeddingGenerationId, "Embedding generation ID");
  validateChunkEmbeddingBatch(
    {
      workspaceId: batch.workspaceId,
      embeddingGenerationId: batch.embeddingGenerationId,
      embeddings: batch.embeddings,
      createdAt: batch.checkedAt,
    },
    dimension,
  );
  if (
    utf8Encoder.encode(JSON.stringify(batch.embeddings)).byteLength >
    embeddingPersistenceMaximumUtf8Bytes
  ) {
    throw new EvidenceStorageError("Embedding batch exceeds the portable byte limit");
  }
}

export function validateEmbeddingGenerationActivation(
  activation: EmbeddingGenerationActivation,
) {
  identifier(activation.workspaceId, "Workspace ID");
  identifier(activation.embeddingGenerationId, "Embedding generation ID");
  validateEmbeddingMetadata(activation.metadata);
  timestamp(activation.activatedAt, "Embedding activation time");
}

export function validateChunkEmbeddingBatch(batch: ChunkEmbeddingBatch, dimension: number) {
  identifier(batch.workspaceId, "Workspace ID");
  identifier(batch.embeddingGenerationId, "Embedding generation ID");
  timestamp(batch.createdAt, "Embedding creation time");
  const chunkIds = new Set<string>();
  for (const embedding of batch.embeddings) {
    identifier(embedding.chunkId, "Evidence chunk ID");
    hash(embedding.contentHash, "Evidence content hash");
    hash(embedding.embeddingInputHash, "Embedding input hash");
    if (chunkIds.has(embedding.chunkId)) {
      throw new EvidenceStorageError("An embedding batch contains a duplicate chunk");
    }
    chunkIds.add(embedding.chunkId);
    if (
      embedding.vector.length !== dimension ||
      embedding.vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new EvidenceStorageError("Embedding vector is invalid");
    }
  }
}

export function validateQuestionSet(questionSet: SavedQuestionSet) {
  identifier(questionSet.id, "Question set ID");
  identifier(questionSet.workspaceId, "Workspace ID");
  boundedText(questionSet.name, "Question set name");
  hash(questionSet.sourceContentHash, "Question set source hash");
  timestamp(questionSet.createdAt, "Question set creation time");
  if (
    !Array.isArray(questionSet.questions) ||
    !Number.isInteger(questionSet.version) ||
    questionSet.version < 1 ||
    questionSet.questions.length === 0 ||
    questionSet.questions.length > questionSetMaximumQuestions
  ) {
    throw new EvidenceStorageError("Question set version or questions are invalid");
  }
  const ids = new Set<string>();
  for (const question of questionSet.questions) {
    identifier(question.id, "Saved question ID");
    boundedText(question.question, "Saved question", 2_000);
    if (
      ids.has(question.id) ||
      !savedQuestionClassifications.has(question.classification) ||
      !savedQuestionOutcomes.has(question.expectedOutcome) ||
      !Array.isArray(question.acceptedSourceIds) ||
      !Array.isArray(question.sourceContentHashes) ||
      question.acceptedSourceIds.length !== question.sourceContentHashes.length ||
      question.acceptedSourceIds.length > questionMaximumSources ||
      question.sourceContentHashes.length > questionMaximumSources
    ) {
      throw new EvidenceStorageError("A saved question is invalid");
    }
    ids.add(question.id);
    const acceptedSourceIds = new Set<string>();
    for (const sourceId of question.acceptedSourceIds) {
      identifier(sourceId, "Accepted source ID");
      if (acceptedSourceIds.has(sourceId)) {
        throw new EvidenceStorageError("A saved question contains a duplicate source ID");
      }
      acceptedSourceIds.add(sourceId);
    }
    for (const sourceHash of question.sourceContentHashes) {
      hash(sourceHash, "Saved question source hash");
    }
  }
}

export function validateEvaluationRunStart(run: EvaluationRunStart) {
  identifier(run.id, "Evaluation run ID");
  identifier(run.workspaceId, "Workspace ID");
  identifier(run.questionSetId, "Question set ID");
  if (run.embeddingGenerationId) {
    identifier(run.embeddingGenerationId, "Embedding generation ID");
  }
  boundedText(run.retrievalMode, "Evaluation retrieval mode");
  if (run.provider) {
    boundedText(run.provider, "Evaluation provider");
  }
  if (run.model) {
    boundedText(run.model, "Evaluation model");
  }
  if (!Number.isInteger(run.indexGeneration) || run.indexGeneration < 0) {
    throw new EvidenceStorageError("Evaluation index generation is invalid");
  }
  timestamp(run.startedAt, "Evaluation start time");
}

export function validateEvaluationRunCompletion(completion: EvaluationRunCompletion) {
  identifier(completion.id, "Evaluation run ID");
  identifier(completion.workspaceId, "Workspace ID");
  timestamp(completion.completedAt, "Evaluation completion time");
  if (completion.status !== "completed" && completion.status !== "failed") {
    throw new EvidenceStorageError("Evaluation completion status is invalid");
  }
  validateEvaluationRunResults(completion.results);
}

function validateEvaluationRunResults(results: unknown) {
  let serializedResults: string | undefined;
  try {
    serializedResults = JSON.stringify(results);
  } catch {
    throw new EvidenceStorageError("Evaluation results must be JSON serializable");
  }
  if (
    serializedResults === undefined ||
    serializedResults.length > evaluationResultsMaximumCharacters
  ) {
    throw new EvidenceStorageError("Evaluation results are required");
  }
}

export function validateEvaluationRunResultsUpdate(
  update: EvaluationRunResultsUpdate,
) {
  identifier(update.id, "Evaluation run ID");
  identifier(update.workspaceId, "Workspace ID");
  validateEvaluationRunResults(update.results);
}

export function validateEvidenceReviewRequest(workspaceId: string, limit: number) {
  identifier(workspaceId, "Workspace ID");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > evidenceReviewMaximumRecords
  ) {
    throw new EvidenceStorageError("Evidence review limit is invalid");
  }
}
