// ABOUTME: Defines atomic private article creation and draft-save persistence contracts.
// ABOUTME: Returns explicit no-write outcomes while keeping immutable revision identity portable.
import type { ArticleChangeKind } from "@/content/article-revision";
import type {
  ArticleReviewAction,
  ArticleReviewState,
} from "@/content/article-workflow";

export type DraftArticleValues = Readonly<{
  id: string;
  workspaceId: string;
  categoryId: string;
  slug: string;
  title: string;
  mdx: string;
  isFaq: boolean;
  authorName: string;
  position: number;
}>;

export type DraftActor = Readonly<{
  memberId: string;
  sessionId: string;
}>;

export type DraftChangeKind = Exclude<
  ArticleChangeKind,
  "migration" | "rollback"
>;

type DraftWrite = Readonly<{
  actor: DraftActor;
  article: DraftArticleValues;
  assets: Readonly<{
    manifestId?: string;
    hashes: readonly string[];
  }>;
  changeKind: DraftChangeKind;
  changeSummary?: string | null;
}>;

export type CreateDraftArticleRequest = DraftWrite;

export type SaveDraftArticleRequest = DraftWrite &
  Readonly<{
    expectedWorkingRevisionNumber: number;
  }>;

export type DraftWriteConflictCode =
  | "ARTICLE_EXISTS"
  | "SLUG_CONFLICT"
  | "STALE_REVISION";

export type DraftWriteRejectionCode =
  | "ACTOR_FORBIDDEN"
  | "ARTICLE_ARCHIVED"
  | "ARTICLE_NOT_FOUND"
  | "ASSET_UNAVAILABLE"
  | "CATEGORY_CHANGED"
  | "CATEGORY_UNAVAILABLE"
  | "INVALID_REVIEW_STATE"
  | "INVALID_REVISION_NUMBER";

export type DraftWriteResult =
  | Readonly<{
      status: "saved";
      articleId: string;
      revisionId: string;
      revisionNumber: number;
    }>
  | Readonly<{
      status: "unchanged";
      articleId: string;
      revisionId: string;
      revisionNumber: number;
    }>
  | Readonly<{
      status: "conflict";
      code: DraftWriteConflictCode;
      currentRevisionNumber?: number;
    }>
  | Readonly<{
      status: "rejected";
      code: DraftWriteRejectionCode;
    }>;

type ArticleWorkflowTarget = Readonly<{
  actor: DraftActor;
  articleId: string;
  expectedReviewState: ArticleReviewState;
  expectedWorkingRevisionNumber: number;
  revisionId: string;
  workspaceId: string;
}>;

export type SubmitArticleForReviewRequest = ArticleWorkflowTarget &
  Readonly<{
    expectedReviewState: "editing" | "changes_requested";
    note?: string | null;
  }>;

export type WithdrawArticleReviewRequest = ArticleWorkflowTarget &
  Readonly<{
    expectedReviewState: "in_review";
    note?: string | null;
  }>;

export type RequestArticleChangesRequest = ArticleWorkflowTarget &
  Readonly<{
    expectedReviewState: "in_review";
    note: string;
  }>;

export type ApproveArticleRevisionRequest = ArticleWorkflowTarget &
  Readonly<{
    expectedReviewState: "in_review";
    note?: string | null;
  }>;

export type ApproveAndPublishArticleRevisionRequest = ArticleWorkflowTarget &
  Readonly<{
    expectedReviewState: "in_review";
    note?: string | null;
  }>;

export type PublishArticleRevisionRequest = ArticleWorkflowTarget &
  Readonly<{
    expectedReviewState: "approved";
  }>;

export type EmergencyPublishArticleRequest = ArticleWorkflowTarget &
  Readonly<{
    reason: string;
  }>;

export type UnpublishArticleRequest = ArticleWorkflowTarget &
  Readonly<{
    note?: string | null;
  }>;

export type ArticleWorkflowConflictCode =
  | "INVALID_PUBLICATION_STATE"
  | "INVALID_REVIEW_STATE"
  | "REVISION_MISMATCH"
  | "SLUG_CONFLICT"
  | "STALE_REVISION";

export type ArticleWorkflowRejectionCode =
  | "ACTOR_FORBIDDEN"
  | "ARTICLE_ARCHIVED"
  | "ARTICLE_NOT_FOUND"
  | "ASSET_UNAVAILABLE"
  | "CATEGORY_CHANGED"
  | "CATEGORY_UNAVAILABLE"
  | "INVALID_REVISION_NUMBER"
  | "ARTICLE_NOT_ARCHIVED"
  | "REVISION_INTEGRITY_FAILED"
  | "REVISION_NOT_FOUND"
  | "UNSAFE_REVISION"
  | "SELF_APPROVAL_FORBIDDEN";

export type ArticleWorkflowResult =
  | Readonly<{
      status: "transitioned";
      action: ArticleReviewAction;
      approvalEventId?: string;
      articleId: string;
      eventId: string;
      evidenceJobId?: string;
      publicStatus: "draft" | "published";
      reviewState: ArticleReviewState;
      revisionId: string;
      revisionNumber: number;
    }>
  | Readonly<{
      status: "conflict";
      code: ArticleWorkflowConflictCode;
      currentReviewState?: ArticleReviewState;
      currentRevisionNumber?: number;
    }>
  | Readonly<{
      status: "rejected";
      code: ArticleWorkflowRejectionCode;
    }>;

export type ArticleWorkingHeadRequest = Readonly<{
  actor: DraftActor;
  articleId: string;
  workspaceId: string;
}>;

export type ArticleLibraryRequest = Readonly<{
  actor: DraftActor;
  workspaceId: string;
}>;

export type ArticleLibraryItem = Readonly<{
  archivedAt: Date | null;
  articleId: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  createdByMemberId: string | null;
  publicStatus: "draft" | "published";
  publishedRevisionId: string | null;
  publishedRevisionNumber: number | null;
  reviewState: ArticleReviewState;
  slug: string;
  submittedByMemberId: string | null;
  title: string;
  updatedAt: Date;
  workingRevisionId: string;
  workingRevisionNumber: number;
}>;

export type ArticleWorkingHead = Readonly<{
  article: DraftArticleValues;
  archivedAt: Date | null;
  assetHashes: readonly string[];
  changeKind: ArticleChangeKind;
  changeSummary: string | null;
  createdAt: Date;
  createdByMemberId: string | null;
  createdBySystemLabel: string | null;
  publicStatus: "draft" | "published";
  publishedRevisionId: string | null;
  publishedRevisionNumber: number | null;
  reviewState: ArticleReviewState;
  revisionHash: string;
  revisionId: string;
  revisionNumber: number;
  submittedByMemberId: string | null;
}>;

export const articleRevisionHistoryPageLimit = 20;
export const articleRevisionDetailEventLimit = 50;

export type ArticleRevisionHistoryRequest = Readonly<{
  actor: DraftActor;
  articleId: string;
  beforeRevisionNumber?: number;
  limit?: number;
  workspaceId: string;
}>;

export type ArticleRevisionHistoryEvent = Readonly<{
  action: ArticleReviewAction;
  createdAt: Date;
  id: string;
  memberDisplayName: string;
  memberId: string;
  note: string | null;
}>;

export type ArticleRevisionSummary = Readonly<{
  changeKind: ArticleChangeKind;
  changeSummary: string | null;
  createdAt: Date;
  createdByDisplayName: string;
  createdByMemberId: string | null;
  isPublishedRevision: boolean;
  isWorkingRevision: boolean;
  restoredFromRevisionId: string | null;
  revisionHash: string;
  revisionId: string;
  revisionNumber: number;
  title: string;
}>;

export type ArticleRevisionHistoryPage = Readonly<{
  articleId: string;
  items: readonly ArticleRevisionSummary[];
  nextBeforeRevisionNumber: number | null;
}>;

export type ArticleRevisionDetailRequest = Readonly<{
  actor: DraftActor;
  articleId: string;
  revisionId: string;
  revisionNumber: number;
  workspaceId: string;
}>;

export type ArticleRevisionDetail = Readonly<{
  article: DraftArticleValues;
  assetHashes: readonly string[];
  categoryName: string;
  categorySlug: string;
  changeKind: ArticleChangeKind;
  changeSummary: string | null;
  createdAt: Date;
  createdByDisplayName: string;
  createdByMemberId: string | null;
  events: readonly ArticleRevisionHistoryEvent[];
  eventsTruncated: boolean;
  restoredFromRevisionId: string | null;
  revisionHash: string;
  revisionId: string;
  revisionNumber: number;
}>;

export type RestoreRevisionAsDraftRequest = Readonly<{
  actor: DraftActor;
  articleId: string;
  changeSummary?: string | null;
  expectedReviewState: Exclude<ArticleReviewState, "in_review">;
  expectedWorkingRevisionNumber: number;
  sourceRevisionId: string;
  sourceRevisionNumber: number;
  workspaceId: string;
}>;

type ArticleArchiveTarget = Readonly<{
  actor: DraftActor;
  articleId: string;
  expectedPublicStatus: "draft" | "published";
  expectedReviewState: ArticleReviewState;
  expectedWorkingRevisionNumber: number;
  revisionId: string;
  workspaceId: string;
}>;

export type ArchiveArticleRequest = ArticleArchiveTarget &
  Readonly<{ note?: string | null }>;

export type RestoreArchivedArticleRequest = ArticleArchiveTarget &
  Readonly<{ note?: string | null }>;

export type ArticleDraftRepository = {
  archiveArticle(request: ArchiveArticleRequest): Promise<ArticleWorkflowResult>;
  approveAndPublishArticleRevision(
    request: ApproveAndPublishArticleRevisionRequest,
  ): Promise<ArticleWorkflowResult>;
  approveArticleRevision(
    request: ApproveArticleRevisionRequest,
  ): Promise<ArticleWorkflowResult>;
  createDraftArticle(request: CreateDraftArticleRequest): Promise<DraftWriteResult>;
  emergencyPublishArticle(
    request: EmergencyPublishArticleRequest,
  ): Promise<ArticleWorkflowResult>;
  getArticleWorkingHead(
    request: ArticleWorkingHeadRequest,
  ): Promise<ArticleWorkingHead | null>;
  getArticleRevisionDetail(
    request: ArticleRevisionDetailRequest,
  ): Promise<ArticleRevisionDetail | null>;
  listArticleLibrary(request: ArticleLibraryRequest): Promise<readonly ArticleLibraryItem[]>;
  listArticleRevisionHistory(
    request: ArticleRevisionHistoryRequest,
  ): Promise<ArticleRevisionHistoryPage | null>;
  publishArticleRevision(
    request: PublishArticleRevisionRequest,
  ): Promise<ArticleWorkflowResult>;
  requestArticleChanges(
    request: RequestArticleChangesRequest,
  ): Promise<ArticleWorkflowResult>;
  restoreArchivedArticle(
    request: RestoreArchivedArticleRequest,
  ): Promise<ArticleWorkflowResult>;
  restoreRevisionAsDraft(
    request: RestoreRevisionAsDraftRequest,
  ): Promise<ArticleWorkflowResult>;
  saveDraftArticle(request: SaveDraftArticleRequest): Promise<DraftWriteResult>;
  submitArticleForReview(
    request: SubmitArticleForReviewRequest,
  ): Promise<ArticleWorkflowResult>;
  unpublishArticle(
    request: UnpublishArticleRequest,
  ): Promise<ArticleWorkflowResult>;
  withdrawArticleReview(
    request: WithdrawArticleReviewRequest,
  ): Promise<ArticleWorkflowResult>;
};

export type ArticleDraftRepositoryOptions = Readonly<{
  clock?: () => Date;
  configuredSiteUrl?: string;
  createEvidenceId?: () => string;
  createReviewEventId?: () => string;
  createRevisionId?: () => string;
}>;

export function draftRepositoryClock(options?: ArticleDraftRepositoryOptions) {
  const changedAt = options?.clock?.() ?? new Date();
  if (!Number.isFinite(changedAt.getTime())) {
    throw new Error("Article revision time must be valid.");
  }
  return changedAt;
}

export function draftRepositoryRevisionId(
  options?: ArticleDraftRepositoryOptions,
) {
  return options?.createRevisionId?.() ?? `revision_${crypto.randomUUID()}`;
}

export function draftRepositoryReviewEventId(
  options?: ArticleDraftRepositoryOptions,
) {
  return options?.createReviewEventId?.() ?? `review_event_${crypto.randomUUID()}`;
}

export function draftReviewNote(
  note: string | null | undefined,
  required = false,
) {
  const normalized = note?.trim() || null;
  if (required && normalized === null) {
    throw new Error("A review note is required.");
  }
  if (normalized !== null && normalized.length > 500) {
    throw new Error("Review notes must be 500 characters or fewer.");
  }
  return normalized;
}

export function draftChangeSummary(summary: string | null | undefined) {
  const normalized = summary?.trim() || null;
  if (normalized !== null && normalized.length > 500) {
    throw new Error("Article revision summaries must be 500 characters or fewer.");
  }
  return normalized;
}
