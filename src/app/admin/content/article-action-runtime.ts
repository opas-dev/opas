// ABOUTME: Executes validated private saves and exact-revision article workflow transitions.
// ABOUTME: Maps durable repository outcomes to bounded editor feedback without exposing database errors.

import { failedArticleAssetManifestStatus } from "@/app/admin/content/article-asset-state";
import type {
  ArticleWorkflowActionState,
  ContentActionState,
} from "@/app/admin/content/article-action-contracts";
import {
  parseArticleRequest,
  parseArticleWorkflowRequest,
  type ArticleWorkflowIntent,
  type ContentFieldErrors,
} from "@/app/admin/content/validation";
import { getAuthoringPausedFailure } from "@/authoring/failures";
import { referencedArticleAssetHashes } from "@/content/article-assets";
import {
  ArticleMdxValidationError,
  validateArticleMdx,
} from "@/content/mdx-safety";
import type {
  ArticleDraftRepository,
  ArticleWorkflowResult,
  DraftActor,
  DraftWriteResult,
} from "@/db/article-drafts";

type ArticleAuthoringRepository = Pick<
  ArticleDraftRepository,
  | "approveAndPublishArticleRevision"
  | "approveArticleRevision"
  | "createDraftArticle"
  | "emergencyPublishArticle"
  | "getArticleWorkingHead"
  | "publishArticleRevision"
  | "requestArticleChanges"
  | "saveDraftArticle"
  | "submitArticleForReview"
  | "unpublishArticle"
  | "withdrawArticleReview"
>;

export type ArticleActionDependencies = Readonly<{
  actor: DraftActor;
  createArticleId?: () => string;
  reportFailure?: (operation: "save" | "workflow", error: unknown) => void;
  repository: ArticleAuthoringRepository;
  revalidateContent?: () => void;
  scheduleEvidenceRecovery?: () => void;
  workspaceId: string;
}>;

function saveErrorState(
  previousState: ContentActionState,
  message: string,
  options: Pick<
    ContentActionState,
    | "assetManifestStatus"
    | "code"
    | "currentRevisionNumber"
    | "fieldErrors"
  > = {},
): ContentActionState {
  return {
    status: "error",
    message,
    revision: previousState.revision + 1,
    persistedRevisionId: previousState.persistedRevisionId,
    persistedRevisionNumber: previousState.persistedRevisionNumber,
    ...options,
  };
}

function draftConflictState(
  previousState: ContentActionState,
  result: Extract<DraftWriteResult, { status: "conflict" }>,
) {
  if (result.code === "SLUG_CONFLICT") {
    return saveErrorState(previousState, "That URL slug is already used by another article.", {
      code: result.code,
      fieldErrors: { slug: "Choose a unique URL slug." },
    });
  }
  if (result.code === "STALE_REVISION") {
    const latest = result.currentRevisionNumber
      ? ` Revision ${result.currentRevisionNumber} is now the latest saved version.`
      : "";
    return saveErrorState(
      previousState,
      `This article changed in another tab.${latest} Your local changes and staged images are still here.`,
      {
        code: result.code,
        currentRevisionNumber: result.currentRevisionNumber,
      },
    );
  }
  return saveErrorState(
    previousState,
    "This article was created elsewhere before this save completed. Reload before trying again.",
    { code: result.code },
  );
}

function draftRejectionState(
  previousState: ContentActionState,
  result: Extract<DraftWriteResult, { status: "rejected" }>,
) {
  const message = {
    ACTOR_FORBIDDEN: "Your access changed before the article could be saved.",
    ARTICLE_ARCHIVED: "Restore this article before editing it.",
    ARTICLE_NOT_FOUND: "That article no longer exists.",
    ASSET_UNAVAILABLE:
      "One or more images are no longer available. Re-upload or remove them before saving.",
    CATEGORY_CHANGED:
      "That category changed while you were editing. Reload before saving this revision.",
    CATEGORY_UNAVAILABLE: "Choose an available category from this workspace.",
    INVALID_REVIEW_STATE: "This revision is in review. Withdraw it before editing.",
    INVALID_REVISION_NUMBER: "The saved revision is invalid. Reload before trying again.",
  }[result.code];
  const fieldErrors: ContentFieldErrors | undefined =
    result.code === "ASSET_UNAVAILABLE"
      ? { mdx: "Re-upload or remove each unavailable image." }
      : result.code === "CATEGORY_UNAVAILABLE"
        ? { categoryId: "That category is unavailable." }
        : undefined;
  return saveErrorState(previousState, message, {
    code: result.code,
    fieldErrors,
  });
}

export async function runSaveArticleAction(
  previousState: ContentActionState,
  formData: FormData,
  dependencies: ArticleActionDependencies,
): Promise<ContentActionState> {
  const request = parseArticleRequest(formData);
  if (!request.success) {
    return saveErrorState(
      previousState,
      "Review the highlighted article fields.",
      { fieldErrors: request.fieldErrors },
    );
  }

  try {
    await validateArticleMdx(request.data.mdx, request.data.title);
  } catch (error) {
    const message =
      error instanceof ArticleMdxValidationError
        ? error.message
        : "Article MDX could not be validated.";
    return saveErrorState(
      previousState,
      "The article contains unsafe or invalid MDX.",
      { fieldErrors: { mdx: message } },
    );
  }

  const articleId =
    request.data.mode === "update"
      ? request.data.id
      : (dependencies.createArticleId?.() ?? `article_${crypto.randomUUID()}`);
  let mutationAttempted = false;

  try {
    const currentHead =
      request.data.mode === "update"
        ? await dependencies.repository.getArticleWorkingHead({
            actor: dependencies.actor,
            articleId,
            workspaceId: dependencies.workspaceId,
          })
        : null;
    if (request.data.mode === "update" && !currentHead) {
      return saveErrorState(
        previousState,
        "That article is unavailable. Reload the content library and try again.",
        { code: "ARTICLE_NOT_FOUND" },
      );
    }

    const article = {
      id: articleId,
      workspaceId: dependencies.workspaceId,
      categoryId: request.data.categoryId,
      slug: request.data.slug,
      title: request.data.title,
      mdx: request.data.mdx,
      isFaq: request.data.isFaq,
      authorName: request.data.authorName,
      position: currentHead?.article.position ?? 0,
    };
    const assets = {
      manifestId: request.data.assetManifestId,
      hashes: referencedArticleAssetHashes(request.data.mdx),
    };
    mutationAttempted = true;
    const result =
      request.data.mode === "create"
        ? await dependencies.repository.createDraftArticle({
            actor: dependencies.actor,
            article,
            assets,
            changeKind: "manual",
          })
        : await dependencies.repository.saveDraftArticle({
            actor: dependencies.actor,
            article,
            assets,
            changeKind: "manual",
            expectedWorkingRevisionNumber:
              request.data.expectedWorkingRevisionNumber,
          });

    if (result.status === "conflict") {
      return draftConflictState(previousState, result);
    }
    if (result.status === "rejected") {
      return draftRejectionState(previousState, result);
    }

    dependencies.revalidateContent?.();
    return {
      status: "success",
      message:
        result.status === "unchanged"
          ? `Revision ${result.revisionNumber} is already saved.`
          : `Saved as revision ${result.revisionNumber}.`,
      revision: previousState.revision + 1,
      articleId: result.articleId,
      created: request.data.mode === "create",
      persistedRevisionId: result.revisionId,
      persistedRevisionNumber: result.revisionNumber,
    };
  } catch (error) {
    const paused = getAuthoringPausedFailure(error);
    if (paused) {
      return saveErrorState(previousState, paused.message, { code: paused.code });
    }
    dependencies.reportFailure?.("save", error);
    const assetManifestStatus = mutationAttempted
      ? failedArticleAssetManifestStatus(request.data.assetManifestId, error)
      : undefined;
    if (assetManifestStatus) {
      return saveErrorState(
        previousState,
        assetManifestStatus === "discarded"
          ? "The article was not saved. Its staged image session was discarded; re-upload each unsaved image still in the source or remove it before retrying."
          : "The article was not saved and staged-image cleanup could not be confirmed. Re-upload each unsaved image still in the source or remove it before retrying.",
        {
          assetManifestStatus,
          fieldErrors: {
            mdx:
              "The previous image staging session cannot be reused. Re-upload or remove its unsaved images.",
          },
        },
      );
    }
    return saveErrorState(
      previousState,
      "The article could not be saved. Your local changes are still here; try again.",
    );
  }
}

function workflowErrorState(
  message: string,
  options: Omit<ArticleWorkflowActionState, "message" | "status"> = {},
): ArticleWorkflowActionState {
  return Object.freeze({ status: "error", message, ...options });
}

function workflowConflictState(
  result: Extract<ArticleWorkflowResult, { status: "conflict" }>,
) {
  const latest = result.currentRevisionNumber
    ? ` Revision ${result.currentRevisionNumber} is now current.`
    : "";
  const message =
    result.code === "SLUG_CONFLICT"
      ? "That article URL is now used elsewhere. Resolve the slug before publishing."
      : result.code === "INVALID_PUBLICATION_STATE"
        ? "The live publication state changed before this action completed. Reload and review it."
        : result.code === "INVALID_REVIEW_STATE"
          ? `The review state changed before this action completed.${latest}`
          : `This article changed before the action completed.${latest}`;
  return workflowErrorState(message, {
    code: result.code,
    currentReviewState: result.currentReviewState,
    currentRevisionNumber: result.currentRevisionNumber,
  });
}

function workflowRejectionState(
  result: Extract<ArticleWorkflowResult, { status: "rejected" }>,
) {
  const message = {
    ACTOR_FORBIDDEN: "Your access changed before this action could be completed.",
    ARTICLE_ARCHIVED: "Restore this article before changing its workflow.",
    ARTICLE_NOT_ARCHIVED: "This article is not archived.",
    ARTICLE_NOT_FOUND: "That article no longer exists.",
    ASSET_UNAVAILABLE: "A revision image is unavailable, so this revision cannot be published.",
    CATEGORY_CHANGED:
      "The category changed after this revision was saved. Save a new revision before continuing.",
    CATEGORY_UNAVAILABLE:
      "The saved category is unavailable. Choose a category and save a new revision.",
    INVALID_REVISION_NUMBER: "The saved revision is invalid. Reload before trying again.",
    REVISION_INTEGRITY_FAILED:
      "This saved revision failed its integrity check and cannot be used.",
    REVISION_NOT_FOUND: "That saved revision no longer exists. Reload before trying again.",
    SELF_APPROVAL_FORBIDDEN:
      "A different reviewer must decide on a revision you created or submitted.",
    UNSAFE_REVISION: "This saved revision no longer meets the current content safety policy.",
  }[result.code];
  return workflowErrorState(message, { code: result.code });
}

function workflowSuccessMessage(
  intent: ArticleWorkflowIntent,
  revisionNumber: number,
) {
  return {
    approve: `Revision ${revisionNumber} was approved and remains private.`,
    approveAndPublish: `Revision ${revisionNumber} was approved and published.`,
    emergencyPublish: `Revision ${revisionNumber} was published with the emergency reason recorded.`,
    publish: `Approved revision ${revisionNumber} is now live.`,
    requestChanges: `Changes were requested on revision ${revisionNumber}.`,
    submit: `Revision ${revisionNumber} was submitted for review.`,
    unpublish: "The live article was unpublished. Its revision history was kept.",
    withdraw: `Revision ${revisionNumber} was withdrawn. You can edit it again.`,
  }[intent];
}

export async function runArticleWorkflowAction(
  intent: ArticleWorkflowIntent,
  formData: FormData,
  dependencies: ArticleActionDependencies,
): Promise<ArticleWorkflowActionState> {
  const request = parseArticleWorkflowRequest(intent, formData);
  if (!request.success) {
    return workflowErrorState("The article action is invalid. Reload and try again.");
  }
  const target = {
    actor: dependencies.actor,
    articleId: request.data.id,
    expectedWorkingRevisionNumber: request.data.expectedWorkingRevisionNumber,
    revisionId: request.data.revisionId,
    workspaceId: dependencies.workspaceId,
  };

  try {
    let result: ArticleWorkflowResult;
    if (intent === "submit") {
      if (
        request.data.expectedReviewState !== "editing" &&
        request.data.expectedReviewState !== "changes_requested"
      ) {
        return workflowErrorState("The article action is invalid. Reload and try again.");
      }
      result = await dependencies.repository.submitArticleForReview({
        ...target,
        expectedReviewState: request.data.expectedReviewState,
        note: request.data.note,
      });
    } else if (intent === "withdraw") {
      result = await dependencies.repository.withdrawArticleReview({
        ...target,
        expectedReviewState: "in_review",
        note: request.data.note,
      });
    } else if (intent === "requestChanges") {
      if (!request.data.note) {
        return workflowErrorState("Enter a reason before requesting changes.");
      }
      result = await dependencies.repository.requestArticleChanges({
        ...target,
        expectedReviewState: "in_review",
        note: request.data.note,
      });
    } else if (intent === "approve") {
      result = await dependencies.repository.approveArticleRevision({
        ...target,
        expectedReviewState: "in_review",
        note: request.data.note,
      });
    } else if (intent === "approveAndPublish") {
      result = await dependencies.repository.approveAndPublishArticleRevision({
        ...target,
        expectedReviewState: "in_review",
        note: request.data.note,
      });
    } else if (intent === "publish") {
      result = await dependencies.repository.publishArticleRevision({
        ...target,
        expectedReviewState: "approved",
      });
    } else if (intent === "emergencyPublish") {
      if (!request.data.reason) {
        return workflowErrorState("Enter a reason before publishing outside review.");
      }
      result = await dependencies.repository.emergencyPublishArticle({
        ...target,
        expectedReviewState: request.data.expectedReviewState,
        reason: request.data.reason,
      });
    } else {
      result = await dependencies.repository.unpublishArticle({
        ...target,
        expectedReviewState: request.data.expectedReviewState,
        note: request.data.note,
      });
    }

    if (result.status === "conflict") return workflowConflictState(result);
    if (result.status === "rejected") return workflowRejectionState(result);

    if (result.evidenceJobId) {
      try {
        dependencies.scheduleEvidenceRecovery?.();
      } catch (error) {
        dependencies.reportFailure?.("workflow", error);
      }
    }
    dependencies.revalidateContent?.();
    return Object.freeze({
      status: "success",
      message: workflowSuccessMessage(intent, result.revisionNumber),
      publicStatus: result.publicStatus,
      reviewState: result.reviewState,
      revisionId: result.revisionId,
      revisionNumber: result.revisionNumber,
    });
  } catch (error) {
    const paused = getAuthoringPausedFailure(error);
    if (paused) return workflowErrorState(paused.message, { code: paused.code });
    dependencies.reportFailure?.("workflow", error);
    return workflowErrorState(
      "The article action could not be completed. Reload and try again.",
    );
  }
}
