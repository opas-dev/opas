// ABOUTME: Defines client-safe feedback and exact snapshots for article recovery actions.
// ABOUTME: Carries typed conflicts without exposing persistence errors or mutable records.

import type { ArticleReviewState } from "@/content/article-workflow";
import type {
  ArticleWorkflowConflictCode,
  ArticleWorkflowRejectionCode,
} from "@/db/article-drafts";

export type ArticleRecoveryCode =
  | "AUTHORING_PAUSED"
  | ArticleWorkflowConflictCode
  | ArticleWorkflowRejectionCode;

export type ArticleRecoveryActionState = Readonly<{
  status: "idle" | "error" | "success";
  message: string;
  code?: ArticleRecoveryCode;
  currentReviewState?: ArticleReviewState;
  currentRevisionNumber?: number;
  publicStatus?: "draft" | "published";
  reviewState?: ArticleReviewState;
  revisionId?: string;
  revisionNumber?: number;
}>;

export type ArticleRecoveryAction = (
  previousState: ArticleRecoveryActionState,
  formData: FormData,
) => Promise<ArticleRecoveryActionState>;

export type ArticleRecoverySnapshot = Readonly<{
  articleId: string;
  publicStatus: "draft" | "published";
  reviewState: ArticleReviewState;
  revisionId: string;
  revisionNumber: number;
}>;

export const initialArticleRecoveryState: ArticleRecoveryActionState = Object.freeze({
  status: "idle",
  message: "",
});
