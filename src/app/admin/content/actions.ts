// ABOUTME: Applies authenticated category and article changes for the demo workspace.
// ABOUTME: Validates ownership, publication state, and MDX safety before repository writes.
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { scheduleEmbeddingRecovery } from "@/ai/embedding-scheduling";
import type {
  ArticleWorkflowActionState,
  ContentActionState,
} from "@/app/admin/content/article-action-contracts";
import {
  runArticleWorkflowAction,
  runSaveArticleAction,
  type ArticleActionDependencies,
} from "@/app/admin/content/article-action-runtime";
import {
  parseCategoryDeleteRequest,
  parseCategoryRequest,
  type ArticleWorkflowIntent,
  type ContentFieldErrors,
} from "@/app/admin/content/validation";
import { getAuthoringPausedFailure } from "@/authoring/failures";
import { requireMemberCapability } from "@/auth/admin";
import type { Capability } from "@/auth/capabilities";
import type { ActiveMemberSession } from "@/auth/member-repository";
import { getRepository } from "@/db";
import { getCategoryAuthoringRepository } from "@/db/category-authoring-database";
import { demoIds } from "@/db/demo";

export type { ContentActionState } from "@/app/admin/content/article-action-contracts";

function databaseErrorDetails(error: unknown) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;

  return {
    type: error instanceof Error ? error.name : "UnknownError",
    code,
  };
}

function errorState(
  previousState: ContentActionState,
  message: string,
  fieldErrors?: ContentFieldErrors,
  assetManifestStatus?: ContentActionState["assetManifestStatus"],
): ContentActionState {
  return {
    status: "error",
    message,
    revision: previousState.revision + 1,
    recordVersion: previousState.recordVersion,
    fieldErrors,
    assetManifestStatus,
  };
}

function successState(
  previousState: ContentActionState,
  message: string,
  recordVersion?: number,
): ContentActionState {
  return {
    status: "success",
    message,
    revision: previousState.revision + 1,
    ...(recordVersion === undefined ? {} : { recordVersion }),
  };
}

function pausedErrorState(
  previousState: ContentActionState,
  error: unknown,
): ContentActionState | null {
  const failure = getAuthoringPausedFailure(error);
  return failure
      ? {
        ...previousState,
        ...failure,
        status: "error",
        revision: previousState.revision + 1,
      }
    : null;
}

function revalidateContent() {
  revalidatePath("/", "layout");
}

export async function saveCategoryAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  const member = await requireMemberCapability("category:manage", demoIds.workspace);
  const request = parseCategoryRequest(formData);

  if (!request.success) {
    return errorState(previousState, "Review the highlighted category fields.", request.fieldErrors);
  }

  const repository = await getCategoryAuthoringRepository();
  const category = {
    id:
      request.data.mode === "update"
        ? request.data.id
        : `category_${crypto.randomUUID()}`,
    workspaceId: demoIds.workspace,
    name: request.data.name,
    slug: request.data.slug,
    description: request.data.description,
    position: request.data.position,
  };

  try {
    const actor = {
      memberId: member.memberId,
      sessionId: member.sessionId,
      workspaceId: member.workspaceId,
    };
    const result =
      request.data.mode === "create"
        ? await repository.createCategory({
            actor,
            category,
            expectedCategoryVersion: 0,
          })
        : await repository.updateCategory({
            actor,
            category,
            expectedCategoryVersion: request.data.expectedCategoryVersion,
          });

    if (result.status === "conflict") {
      return errorState(
        previousState,
        result.code === "STALE_CATEGORY"
          ? "This category changed in another tab. Reload before saving again."
          : result.code === "CATEGORY_SLUG_CONFLICT"
            ? "That URL slug already belongs to another category."
            : "That category already exists.",
      );
    }
    if (result.status === "rejected") {
      return errorState(
        previousState,
        result.code === "CATEGORY_NOT_FOUND"
          ? "That category no longer exists."
          : result.code === "LIVE_CATEGORY_SLUG"
            ? "Unpublish this category's live articles before changing its URL slug."
            : result.code === "ACTOR_FORBIDDEN"
              ? "Your access changed before the category could be saved."
              : "The category request is no longer valid. Reload and try again.",
      );
    }

    revalidateContent();
    return successState(
      previousState,
      request.data.mode === "create"
        ? `${request.data.name} was created.`
        : result.status === "unchanged"
          ? `${request.data.name} is already up to date.`
          : `${request.data.name} was saved.`,
      result.category.version,
    );
  } catch (error) {
    const paused = pausedErrorState(previousState, error);
    if (paused) return paused;
    console.error("Category persistence failed.", databaseErrorDetails(error));
    return errorState(
      previousState,
      "The category could not be saved. Check that its URL slug is unique.",
    );
  }
}

export async function deleteCategoryAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  const member = await requireMemberCapability("category:manage", demoIds.workspace);
  const request = parseCategoryDeleteRequest(formData);

  if (!request.success) {
    return errorState(previousState, "The category request is invalid.", request.fieldErrors);
  }

  const repository = await getCategoryAuthoringRepository();

  try {
    const result = await repository.deleteCategory({
      actor: {
        memberId: member.memberId,
        sessionId: member.sessionId,
        workspaceId: member.workspaceId,
      },
      category: { id: request.data.id, workspaceId: demoIds.workspace },
      expectedCategoryVersion: request.data.expectedCategoryVersion,
    });
    if (result.status === "conflict") {
      return errorState(
        previousState,
        "This category changed in another tab. Reload before deleting it.",
      );
    }
    if (result.status === "rejected") {
      return errorState(
        previousState,
        result.code === "CATEGORY_REFERENCED"
          ? "Move every current category reference first, including references in archived articles."
          : result.code === "CATEGORY_NOT_FOUND"
            ? "That category no longer exists."
            : result.code === "ACTOR_FORBIDDEN"
              ? "Your access changed before the category could be deleted."
              : "The category request is no longer valid. Reload and try again.",
      );
    }
  } catch (error) {
    const paused = pausedErrorState(previousState, error);
    if (paused) return paused;
    console.error("Category deletion failed.", databaseErrorDetails(error));
    return errorState(previousState, "The category could not be deleted. Try again.");
  }

  revalidateContent();
  return successState(previousState, "The category was deleted.");
}

export async function saveArticleAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  const member = await requireMemberCapability("draft:edit", demoIds.workspace);
  let result: ContentActionState;
  try {
    result = await runSaveArticleAction(
      previousState,
      formData,
      await articleActionDependencies(member),
    );
  } catch (error) {
    const paused = pausedErrorState(previousState, error);
    if (paused) return paused;
    console.error("Article persistence failed.", databaseErrorDetails(error));
    return errorState(
      previousState,
      "The article could not be saved. Your local changes are still here; try again.",
    );
  }

  if (result.status === "success" && result.created && result.articleId) {
    redirect(`/admin/content/articles/${result.articleId}`);
  }
  return result;
}

async function articleActionDependencies(
  member: ActiveMemberSession,
): Promise<ArticleActionDependencies> {
  return {
    actor: { memberId: member.memberId, sessionId: member.sessionId },
    repository: await getRepository(),
    revalidateContent,
    reportFailure(operation, error) {
      console.error(
        operation === "save"
          ? "Article persistence failed."
          : "Article workflow failed.",
        databaseErrorDetails(error),
      );
    },
    scheduleEvidenceRecovery: scheduleEmbeddingRecovery,
    workspaceId: demoIds.workspace,
  };
}

async function articleWorkflowAction(
  capability: Capability,
  intent: ArticleWorkflowIntent,
  formData: FormData,
): Promise<ArticleWorkflowActionState> {
  const member = await requireMemberCapability(capability, demoIds.workspace);
  try {
    return await runArticleWorkflowAction(
      intent,
      formData,
      await articleActionDependencies(member),
    );
  } catch (error) {
    const paused = getAuthoringPausedFailure(error);
    if (paused) {
      return { status: "error", message: paused.message, code: paused.code };
    }
    console.error("Article workflow failed.", databaseErrorDetails(error));
    return {
      status: "error",
      message: "The article action could not be completed. Reload and try again.",
    };
  }
}

export async function submitArticleForReviewAction(formData: FormData) {
  return articleWorkflowAction("review:submit", "submit", formData);
}

export async function withdrawArticleReviewAction(formData: FormData) {
  return articleWorkflowAction("review:submit", "withdraw", formData);
}

export async function requestArticleChangesAction(formData: FormData) {
  return articleWorkflowAction("review:decide", "requestChanges", formData);
}

export async function approveArticleRevisionAction(formData: FormData) {
  return articleWorkflowAction("review:decide", "approve", formData);
}

export async function approveAndPublishArticleRevisionAction(formData: FormData) {
  await requireMemberCapability("review:decide", demoIds.workspace);
  return articleWorkflowAction(
    "publication:publish",
    "approveAndPublish",
    formData,
  );
}

export async function publishArticleRevisionAction(formData: FormData) {
  return articleWorkflowAction("publication:publish", "publish", formData);
}

export async function emergencyPublishArticleAction(formData: FormData) {
  return articleWorkflowAction(
    "publication:emergency-publish",
    "emergencyPublish",
    formData,
  );
}

export async function unpublishArticleAction(formData: FormData) {
  return articleWorkflowAction("article:retire", "unpublish", formData);
}
