// ABOUTME: Defines the database-neutral records and operations used by OPAS application code.
// ABOUTME: Keeps deployment driver details behind one small repository contract.
import type { EmbeddingWorkerRepository } from "@/ai/embedding-worker";
import type { ArticleDraftRepository } from "@/db/article-drafts";
import type { MemberActor } from "@/auth/member-repository";

export type ArticleStatus = "draft" | "published";

export type Article = {
  id: string;
  workspaceId: string;
  categoryId: string;
  slug: string;
  title: string;
  mdx: string;
  contentHash: string | null;
  status: ArticleStatus;
  isFaq: boolean;
  authorName: string;
  position: number;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublishedArticle = Omit<Article, "contentHash" | "status">;

export type ArticleSubmission = Omit<
  Article,
  "contentHash" | "createdAt" | "updatedAt" | "position"
> & {
  position?: number;
};

export type AssetMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type Asset = {
  workspaceId: string;
  hash: string;
  mediaType: AssetMediaType;
  byteSize: number;
  content: Uint8Array;
  createdAt: Date;
};

export type AssetUpload = {
  mediaType: string;
  content: Uint8Array;
};

export type AssetManifest = {
  id: string;
  workspaceId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type AssetAuthoringRequest = MemberActor & Readonly<{ checkedAt: Date }>;

export type ArticleAssetSelection = {
  manifestId?: string;
  hashes: readonly string[];
};

export type Category = {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
};

export type KnowledgeImportCategory = Omit<Category, "workspaceId">;

export type KnowledgeImportArticle = Omit<
  ArticleSubmission,
  "workspaceId" | "position"
> & {
  position: number;
  assetHashes: readonly string[];
  evidence: ArticleEvidenceCommit | null;
};

export type KnowledgeImport = {
  workspaceId: string;
  manifestId: string;
  categories: readonly KnowledgeImportCategory[];
  articles: readonly KnowledgeImportArticle[];
};

export type Theme = {
  id: string;
  workspaceId: string;
  name: string;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type Feedback = {
  id: string;
  articleId: string;
  helpful: boolean;
  comment?: string | null;
  createdAt: Date;
};

export type ArticleView = {
  id: string;
  articleId: string;
  viewedAt: Date;
};

export type SearchMiss = {
  id: string;
  workspaceId: string;
  query: string;
  createdAt: Date;
};

export type ArticleAnalytics = {
  articleId: string;
  title: string;
  status: ArticleStatus;
  views: number;
  feedbackCount: number;
  helpfulCount: number;
};

export type SearchMissAnalytics = {
  query: string;
  count: number;
};

export type Analytics = {
  articles: ArticleAnalytics[];
  searchMisses: SearchMissAnalytics[];
};

export type IndexingState = {
  workspaceId: string;
  generation: number;
  activeEmbeddingGenerationId: string | null;
  updatedAt: Date;
};

export type EvidenceChunkSubmission = {
  id: string;
  contentHash: string;
  embeddingInputHash: string;
  ordinal: number;
  title: string;
  headingPath: readonly string[];
  canonicalUrl: string;
  markdown: string;
  evidenceText: string;
  embeddingText: string;
  sourceLineRange: {
    start: number;
    end: number;
  };
};

export type EvidenceChunkRecord = EvidenceChunkSubmission & {
  workspaceId: string;
  articleId: string;
  articleContentHash: string;
  indexGeneration: number;
  publicationState: "published";
  createdAt: Date;
  updatedAt: Date;
};

export type EmbeddingGenerationStatus =
  | "building"
  | "active"
  | "retired"
  | "failed";

export type EmbeddingGeneration = {
  id: string;
  workspaceId: string;
  provider: string;
  model: string;
  dimension: number;
  configurationHash: string;
  status: EmbeddingGenerationStatus;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
};

export type EmbeddingJobStatus =
  | "pending"
  | "leased"
  | "retryable"
  | "completed"
  | "failed"
  | "superseded";

export type EmbeddingJob = {
  id: string;
  workspaceId: string;
  articleId: string;
  articleContentHash: string;
  embeddingGenerationId: string | null;
  indexGeneration: number;
  status: EmbeddingJobStatus;
  attempts: number;
  maximumAttempts: number;
  checkpoint: number;
  availableAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type ArticleEvidenceCommit = {
  workspaceId: string;
  articleId: string;
  categorySlug: string;
  articleContentHash: string;
  chunks: EvidenceChunkSubmission[];
  job: {
    id: string;
    embeddingGenerationId: string | null;
    maximumAttempts: number;
    availableAt: Date;
  };
};

export type UnindexedPublishedArticle = ArticleSubmission & {
  categorySlug: string;
};

export type ArticleEvidenceInitialization = {
  article: UnindexedPublishedArticle;
  evidence: ArticleEvidenceCommit;
  initializedAt: Date;
};

export type EmbeddingGenerationReconciliation = Parameters<
  EmbeddingWorkerRepository["reconcileEmbeddingGeneration"]
>[0];

export type EmbeddingJobClaim = Parameters<
  EmbeddingWorkerRepository["claimEmbeddingJob"]
>[0];

export type EmbeddingJobWorkRequest = Parameters<
  EmbeddingWorkerRepository["getEmbeddingJobWork"]
>[0];

export type EmbeddingJobBatch = Parameters<
  EmbeddingWorkerRepository["saveEmbeddingJobBatch"]
>[0];

export type EmbeddingJobCheckpoint = Parameters<
  EmbeddingWorkerRepository["checkpointEmbeddingJob"]
>[0];

export type EmbeddingJobRetry = Parameters<
  EmbeddingWorkerRepository["retryEmbeddingJob"]
>[0];

export type EmbeddingJobFailure = Parameters<
  EmbeddingWorkerRepository["failEmbeddingJob"]
>[0];

export type EmbeddingJobCompletion = Parameters<
  EmbeddingWorkerRepository["completeEmbeddingJob"]
>[0];

export type EmbeddingGenerationActivation = Parameters<
  EmbeddingWorkerRepository["activateEmbeddingGeneration"]
>[0];

export type ChunkEmbeddingSubmission = {
  chunkId: string;
  contentHash: string;
  embeddingInputHash: string;
  vector: readonly number[];
};

export type ChunkEmbeddingBatch = {
  workspaceId: string;
  embeddingGenerationId: string;
  embeddings: readonly ChunkEmbeddingSubmission[];
  createdAt: Date;
};

export type ActiveChunkEmbedding = {
  workspaceId: string;
  chunkId: string;
  articleId: string;
  contentHash: string;
  embeddingInputHash: string;
  embeddingGenerationId: string;
  provider: string;
  model: string;
  dimension: number;
  configurationHash: string;
  vector: readonly number[];
};

export type EvidenceCandidateIdentity = {
  chunkId: string;
  articleId: string;
  articleContentHash: string;
  contentHash: string;
};

export type EvidenceCandidateRevalidation = {
  workspaceId: string;
  generation: number;
  candidates: readonly EvidenceCandidateIdentity[];
};

export type SavedQuestionClassification =
  | "answerable"
  | "ambiguous"
  | "unsupported"
  | "stale-conflicting"
  | "adversarial";

export type SavedQuestion = {
  id: string;
  classification: SavedQuestionClassification;
  question: string;
  expectedOutcome: "answer" | "abstain" | "either";
  acceptedSourceIds: readonly string[];
  sourceContentHashes: readonly string[];
};

export type SavedQuestionSet = {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  sourceContentHash: string;
  questions: readonly SavedQuestion[];
  createdAt: Date;
};

export type EvaluationRunStatus = "running" | "completed" | "failed";

export type EvaluationRun = {
  id: string;
  workspaceId: string;
  questionSetId: string;
  indexGeneration: number;
  embeddingGenerationId: string | null;
  retrievalMode: string;
  provider: string | null;
  model: string | null;
  status: EvaluationRunStatus;
  results: unknown;
  startedAt: Date;
  completedAt: Date | null;
};

export type EvaluationRunStart = Omit<
  EvaluationRun,
  "status" | "results" | "completedAt"
>;

export type EvaluationRunCompletion = Pick<
  EvaluationRun,
  "id" | "workspaceId" | "results" | "completedAt"
> & {
  status: Exclude<EvaluationRunStatus, "running">;
  completedAt: Date;
};

export type EvaluationRunResultsUpdate = Pick<
  EvaluationRun,
  "id" | "results" | "workspaceId"
>;

export type AnswerInferenceLeaseStatus =
  | "active"
  | "cancelled"
  | "completed"
  | "expired"
  | "failed"
  | "invalid-output"
  | "timeout";

export type AnswerInferenceLease = {
  id: string;
  workspaceId: string;
  provider: string;
  model: string;
  maximumOutputTokens: number;
  reservedMicrodollars: number;
  chargedMicrodollars: number | null;
  status: AnswerInferenceLeaseStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: Date;
  expiresAt: Date;
  reconciledAt: Date | null;
};

export type AnswerInferenceReservation = Omit<
  AnswerInferenceLease,
  "chargedMicrodollars" | "inputTokens" | "outputTokens" | "reconciledAt" | "status"
> & {
  dailyBudgetMicrodollars: number;
  maximumConcurrency: number;
  retentionStartedAt: Date;
  spendWindowStartedAt: Date;
};

export type AnswerInferenceReconciliation = Pick<
  AnswerInferenceLease,
  "chargedMicrodollars" | "id" | "inputTokens" | "outputTokens" | "workspaceId"
> & {
  reconciledAt: Date;
  status: Exclude<AnswerInferenceLeaseStatus, "active" | "expired">;
};

export type Repository = {
  checkHealth(): Promise<void>;
  findPublishedArticle(workspaceId: string, slug: string): Promise<PublishedArticle | null>;
  listPublishedArticles(workspaceId: string): Promise<PublishedArticle[]>;
  listCategories(workspaceId: string): Promise<Category[]>;
  listArticles(workspaceId: string): Promise<Article[]>;
  getArticle(workspaceId: string, id: string): Promise<Article | null>;
  createArticle(
    article: ArticleSubmission,
    assets: ArticleAssetSelection | undefined,
    evidence: ArticleEvidenceCommit | null,
  ): Promise<void>;
  updateArticle(
    article: ArticleSubmission,
    assets: ArticleAssetSelection | undefined,
    evidence: ArticleEvidenceCommit | null,
  ): Promise<void>;
  deleteArticle(workspaceId: string, id: string): Promise<void>;
  createAssetManifest(workspaceId: string, expiresAt: Date): Promise<AssetManifest>;
  stageAsset(
    workspaceId: string,
    manifestId: string,
    upload: AssetUpload,
  ): Promise<Asset>;
  getAsset(workspaceId: string, hash: string): Promise<Asset | null>;
  getPublishedAsset(workspaceId: string, hash: string): Promise<Asset | null>;
  listArticleAssetHashes(workspaceId: string, articleId: string): Promise<string[]>;
  discardAssetManifest(workspaceId: string, manifestId: string): Promise<void>;
  cleanupExpiredAssets(workspaceId: string, expiredAt: Date): Promise<void>;
  createAuthorizedAssetManifest(
    request: AssetAuthoringRequest,
    expiresAt: Date,
  ): Promise<AssetManifest>;
  stageAuthorizedAsset(
    request: AssetAuthoringRequest,
    manifestId: string,
    upload: AssetUpload,
  ): Promise<Asset>;
  discardAuthorizedAssetManifest(
    request: AssetAuthoringRequest,
    manifestId: string,
  ): Promise<void>;
  cleanupAuthorizedExpiredAssets(
    request: AssetAuthoringRequest,
  ): Promise<void>;
  activateKnowledgeImport(knowledgeImport: KnowledgeImport): Promise<void>;
  getTheme(workspaceId: string): Promise<Theme | null>;
  getAnalytics(workspaceId: string): Promise<Analytics>;
  createFeedback(feedback: Feedback): Promise<void>;
  recordView(view: ArticleView): Promise<void>;
  recordSearchMiss(miss: SearchMiss): Promise<void>;
  getIndexingState(workspaceId: string): Promise<IndexingState | null>;
  listUnindexedPublishedArticles(
    workspaceId: string,
    limit: number,
  ): Promise<UnindexedPublishedArticle[]>;
  initializeArticleEvidence(
    initialization: ArticleEvidenceInitialization,
  ): Promise<boolean>;
  createEmbeddingGeneration(generation: EmbeddingGeneration): Promise<void>;
  getActiveEmbeddingGeneration(workspaceId: string): Promise<EmbeddingGeneration | null>;
  commitArticleEvidence(commit: ArticleEvidenceCommit): Promise<IndexingState>;
  invalidateArticleEvidence(
    workspaceId: string,
    articleId: string,
    invalidatedAt: Date,
  ): Promise<IndexingState>;
  listEvidenceChunks(workspaceId: string): Promise<EvidenceChunkRecord[]>;
  getEmbeddingJob(workspaceId: string, id: string): Promise<EmbeddingJob | null>;
  saveChunkEmbeddings(batch: ChunkEmbeddingBatch): Promise<void>;
  listActiveChunkEmbeddings(workspaceId: string): Promise<ActiveChunkEmbedding[]>;
  revalidateEvidenceCandidates(
    request: EvidenceCandidateRevalidation,
  ): Promise<readonly EvidenceCandidateIdentity[]>;
  saveQuestionSet(questionSet: SavedQuestionSet): Promise<void>;
  getQuestionSet(workspaceId: string, id: string): Promise<SavedQuestionSet | null>;
  listQuestionSets(workspaceId: string, limit: number): Promise<readonly SavedQuestionSet[]>;
  startEvaluationRun(run: EvaluationRunStart): Promise<void>;
  finishEvaluationRun(completion: EvaluationRunCompletion): Promise<void>;
  updateEvaluationRunResults(update: EvaluationRunResultsUpdate): Promise<void>;
  getEvaluationRun(workspaceId: string, id: string): Promise<EvaluationRun | null>;
  listEvaluationRuns(workspaceId: string, limit: number): Promise<readonly EvaluationRun[]>;
  reserveAnswerInference(
    reservation: AnswerInferenceReservation,
  ): Promise<AnswerInferenceLease | null>;
  reconcileAnswerInference(
    reconciliation: AnswerInferenceReconciliation,
  ): Promise<AnswerInferenceLease | null>;
  getAnswerInferenceLease(
    workspaceId: string,
    id: string,
  ): Promise<AnswerInferenceLease | null>;
} & EmbeddingWorkerRepository &
  ArticleDraftRepository;

export type EvidenceRepository = Pick<
  Repository,
  | "getIndexingState"
  | "listUnindexedPublishedArticles"
  | "initializeArticleEvidence"
  | "createEmbeddingGeneration"
  | "getActiveEmbeddingGeneration"
  | "commitArticleEvidence"
  | "invalidateArticleEvidence"
  | "listEvidenceChunks"
  | "getEmbeddingJob"
  | "reconcileEmbeddingGeneration"
  | "claimEmbeddingJob"
  | "getEmbeddingJobWork"
  | "saveEmbeddingJobBatch"
  | "checkpointEmbeddingJob"
  | "retryEmbeddingJob"
  | "failEmbeddingJob"
  | "completeEmbeddingJob"
  | "saveChunkEmbeddings"
  | "activateEmbeddingGeneration"
  | "listActiveChunkEmbeddings"
  | "revalidateEvidenceCandidates"
  | "saveQuestionSet"
  | "getQuestionSet"
  | "listQuestionSets"
  | "startEvaluationRun"
  | "finishEvaluationRun"
  | "updateEvaluationRunResults"
  | "getEvaluationRun"
  | "listEvaluationRuns"
>;

export type AnswerInferenceRepository = Pick<
  Repository,
  | "getAnswerInferenceLease"
  | "reconcileAnswerInference"
  | "reserveAnswerInference"
>;
