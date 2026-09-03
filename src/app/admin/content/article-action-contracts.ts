// ABOUTME: Defines stable editor feedback for private saves and revision-pinned workflow actions.
// ABOUTME: Carries persisted revision identity and typed conflict details back to the authoring UI.

import type { ArticleAssetManifestStatus } from "@/app/admin/content/article-asset-state";
import type { ContentFieldErrors } from "@/app/admin/content/validation";
import type { AuthoringPausedFailure } from "@/authoring/failures";
import type { ArticleReviewState } from "@/content/article-workflow";
import type {
  ArticleWorkflowConflictCode,
  ArticleWorkflowRejectionCode,
  DraftWriteConflictCode,
  DraftWriteRejectionCode,
} from "@/db/article-drafts";

export type ArticleActionCode =
  | AuthoringPausedFailure["code"]
  | ArticleWorkflowConflictCode
  | ArticleWorkflowRejectionCode
  | DraftWriteConflictCode
  | DraftWriteRejectionCode;

export type ContentActionState = {
  status: "idle" | "error" | "success";
  message: string;
  revision: number;
  fieldErrors?: ContentFieldErrors;
  assetManifestStatus?: ArticleAssetManifestStatus;
  code?: ArticleActionCode;
  recordVersion?: number;
  articleId?: string;
  created?: boolean;
  currentRevisionNumber?: number;
  persistedRevisionId?: string;
  persistedRevisionNumber?: number;
};

export type ArticleWorkflowActionState = Readonly<{
  status: "error" | "success";
  message: string;
  code?: ArticleActionCode;
  currentReviewState?: ArticleReviewState;
  currentRevisionNumber?: number;
  publicStatus?: "draft" | "published";
  reviewState?: ArticleReviewState;
  revisionId?: string;
  revisionNumber?: number;
}>;

export type ArticleWorkflowAction = (
  formData: FormData,
) => Promise<ArticleWorkflowActionState>;
