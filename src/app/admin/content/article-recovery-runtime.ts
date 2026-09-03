// ABOUTME: Validates and executes archive, archive recovery, and revision restoration.
// ABOUTME: Maps exact repository outcomes to concise, non-leaking team feedback.

import { z } from "zod";

import type { ArticleRecoveryActionState } from "@/app/admin/content/article-recovery-contracts";
import { getAuthoringPausedFailure } from "@/authoring/failures";
import { articleReviewStates } from "@/content/article-workflow";
import type {
  ArticleDraftRepository,
  ArticleWorkflowResult,
  DraftActor,
} from "@/db/article-drafts";

export type ArticleRecoveryIntent = "archive" | "restoreArchive" | "restoreRevision";

type RecoveryRepository = Pick<
  ArticleDraftRepository,
  "archiveArticle" | "restoreArchivedArticle" | "restoreRevisionAsDraft"
>;

export type ArticleRecoveryDependencies = Readonly<{
  actor: DraftActor;
  reportFailure?: (error: unknown) => void;
  repository: RecoveryRepository;
  revalidateContent?: () => void;
  scheduleEvidenceRecovery?: () => void;
  workspaceId: string;
}>;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

const revisionNumber = z.coerce.number().int().safe().min(1);
const note = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((value) => value || null);

const currentTarget = {
  id: identifier,
  revisionId: identifier,
  expectedWorkingRevisionNumber: revisionNumber,
  expectedReviewState: z.enum(articleReviewStates),
};

const archiveSchema = z.strictObject({
  ...currentTarget,
  expectedPublicStatus: z.enum(["draft", "published"]),
  confirmation: z.literal("on"),
  note,
});

const restoreRevisionSchema = z.strictObject({
  ...currentTarget,
  sourceRevisionId: identifier,
  sourceRevisionNumber: revisionNumber,
  confirmation: z.literal("on"),
  note,
});

function formValues(formData: FormData) {
  return Object.fromEntries(
    [...formData.entries()].filter(([name]) => !name.startsWith("$ACTION_")),
  );
}

function parseRecoveryRequest(intent: ArticleRecoveryIntent, formData: FormData) {
  const values = formValues(formData);
  if (intent === "restoreRevision") {
    const parsed = restoreRevisionSchema.safeParse(values);
    return parsed.success
      ? ({ success: true, data: { ...parsed.data, intent: "restoreRevision" } } as const)
      : ({ success: false } as const);
  }
  const parsed = archiveSchema.safeParse(values);
  if (!parsed.success) return { success: false } as const;
  return intent === "archive"
    ? ({ success: true, data: { ...parsed.data, intent: "archive" } } as const)
    : ({ success: true, data: { ...parsed.data, intent: "restoreArchive" } } as const);
}

function conflictState(
  result: Extract<ArticleWorkflowResult, { status: "conflict" }>,
): ArticleRecoveryActionState {
  const latest = result.currentRevisionNumber
    ? ` Revision ${result.currentRevisionNumber} is now current.`
    : "";
  const message =
    result.code === "SLUG_CONFLICT"
      ? "The saved URL is now owned by another article. Nothing was restored."
      : result.code === "INVALID_PUBLICATION_STATE"
        ? "The public state changed before this action completed. Reload and review it."
        : result.code === "INVALID_REVIEW_STATE"
          ? `The review state changed before this action completed.${latest}`
          : `The working revision changed before this action completed.${latest}`;
  return {
    status: "error",
    message,
    code: result.code,
    currentReviewState: result.currentReviewState,
    currentRevisionNumber: result.currentRevisionNumber,
  };
}

function rejectionState(
  result: Extract<ArticleWorkflowResult, { status: "rejected" }>,
): ArticleRecoveryActionState {
  const message = {
    ACTOR_FORBIDDEN: "Your access changed before this action could be completed.",
    ARTICLE_ARCHIVED: "Restore the archived article before restoring a historical revision.",
    ARTICLE_NOT_ARCHIVED: "This article has already been restored.",
    ARTICLE_NOT_FOUND: "That article no longer exists.",
    ASSET_UNAVAILABLE: "A retained image is unavailable, so nothing was restored.",
    CATEGORY_CHANGED: "The saved category changed before this action completed.",
    CATEGORY_UNAVAILABLE: "The saved category is unavailable, so nothing was restored.",
    INVALID_REVISION_NUMBER: "The requested revision is invalid. Reload and try again.",
    REVISION_INTEGRITY_FAILED: "This revision failed its integrity check and cannot be restored.",
    REVISION_NOT_FOUND: "That saved revision no longer exists.",
    SELF_APPROVAL_FORBIDDEN: "A different team member must complete this action.",
    UNSAFE_REVISION: "This revision no longer meets the content safety rules.",
  }[result.code];
  return { status: "error", message, code: result.code };
}

export async function runArticleRecoveryAction(
  intent: ArticleRecoveryIntent,
  formData: FormData,
  dependencies: ArticleRecoveryDependencies,
): Promise<ArticleRecoveryActionState> {
  const parsed = parseRecoveryRequest(intent, formData);
  if (!parsed.success) {
    return {
      status: "error",
      message: "The confirmation or saved revision is invalid. Reload and try again.",
    };
  }
  const request = parsed.data;

  const target = {
    actor: dependencies.actor,
    articleId: request.id,
    expectedReviewState: request.expectedReviewState,
    expectedWorkingRevisionNumber: request.expectedWorkingRevisionNumber,
    workspaceId: dependencies.workspaceId,
  };

  try {
    let result: ArticleWorkflowResult;
    if (request.intent === "restoreRevision") {
      if (request.expectedReviewState === "in_review") {
        return {
          status: "error",
          message: "Withdraw this article from review before restoring another revision.",
          code: "INVALID_REVIEW_STATE",
        };
      }
      result = await dependencies.repository.restoreRevisionAsDraft({
        ...target,
        expectedReviewState: request.expectedReviewState,
        sourceRevisionId: request.sourceRevisionId,
        sourceRevisionNumber: request.sourceRevisionNumber,
        changeSummary: request.note,
      });
    } else {
      const archiveRequest = {
        ...target,
        expectedPublicStatus: request.expectedPublicStatus,
        revisionId: request.revisionId,
        note: request.note,
      };
      result =
        request.intent === "archive"
          ? await dependencies.repository.archiveArticle(archiveRequest)
          : await dependencies.repository.restoreArchivedArticle(archiveRequest);
    }

    if (result.status === "conflict") return conflictState(result);
    if (result.status === "rejected") return rejectionState(result);

    if (result.evidenceJobId) {
      try {
        dependencies.scheduleEvidenceRecovery?.();
      } catch (error) {
        dependencies.reportFailure?.(error);
      }
    }
    dependencies.revalidateContent?.();
    let message: string;
    if (request.intent === "archive") {
      message = "Article archived. It is no longer public, and its history and images were kept.";
    } else if (request.intent === "restoreArchive") {
      message = "Article restored as a private draft. Its history and images are intact.";
    } else {
      message = `Revision ${request.sourceRevisionNumber} was restored as new private revision ${result.revisionNumber}.`;
    }
    return {
      status: "success",
      message,
      publicStatus: result.publicStatus,
      reviewState: result.reviewState,
      revisionId: result.revisionId,
      revisionNumber: result.revisionNumber,
    };
  } catch (error) {
    const paused = getAuthoringPausedFailure(error);
    if (paused) {
      return { status: "error", message: paused.message, code: paused.code };
    }
    dependencies.reportFailure?.(error);
    return {
      status: "error",
      message: "The article could not be changed. Reload and try again.",
    };
  }
}
