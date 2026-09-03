// ABOUTME: Defines atomic private article creation and draft-save persistence contracts.
// ABOUTME: Returns explicit no-write outcomes while keeping immutable revision identity portable.
import type { ArticleChangeKind } from "@/content/article-revision";

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

export type ArticleDraftRepository = {
  createDraftArticle(request: CreateDraftArticleRequest): Promise<DraftWriteResult>;
  saveDraftArticle(request: SaveDraftArticleRequest): Promise<DraftWriteResult>;
};

export type ArticleDraftRepositoryOptions = Readonly<{
  clock?: () => Date;
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

export function draftChangeSummary(summary: string | null | undefined) {
  const normalized = summary?.trim() || null;
  if (normalized !== null && normalized.length > 500) {
    throw new Error("Article revision summaries must be 500 characters or fewer.");
  }
  return normalized;
}
