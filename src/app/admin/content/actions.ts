// ABOUTME: Applies authenticated category and article changes for the demo workspace.
// ABOUTME: Validates ownership, publication state, and MDX safety before repository writes.
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { scheduleEmbeddingRecovery } from "@/ai/embedding-scheduling";
import {
  parseArticleRequest,
  parseCategoryRequest,
  parseRecordRequest,
  type ContentFieldErrors,
} from "@/app/admin/content/validation";
import {
  failedArticleAssetManifestStatus,
  type ArticleAssetManifestStatus,
} from "@/app/admin/content/article-asset-state";
import { requireAdmin } from "@/auth/admin";
import { referencedArticleAssetHashes } from "@/content/article-assets";
import { prepareArticleEvidence } from "@/content/article-evidence";
import {
  ArticleMdxValidationError,
  validateArticleMdx,
} from "@/content/mdx-safety";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export type ContentActionState = {
  status: "idle" | "error" | "success";
  message: string;
  revision: number;
  fieldErrors?: ContentFieldErrors;
  assetManifestStatus?: ArticleAssetManifestStatus;
};

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
    fieldErrors,
    assetManifestStatus,
  };
}

function successState(previousState: ContentActionState, message: string): ContentActionState {
  return {
    status: "success",
    message,
    revision: previousState.revision + 1,
  };
}

function revalidateContent() {
  revalidatePath("/", "layout");
}

export async function saveCategoryAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  await requireAdmin();
  const request = parseCategoryRequest(formData);

  if (!request.success) {
    return errorState(previousState, "Review the highlighted category fields.", request.fieldErrors);
  }

  const repository = await getRepository();
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

  if (request.data.mode === "update") {
    const categories = await repository.listCategories(demoIds.workspace);
    if (!categories.some((candidate) => candidate.id === category.id)) {
      return errorState(previousState, "That category no longer exists.");
    }
  }

  try {
    if (request.data.mode === "create") {
      await repository.createCategory(category);
    } else {
      const updated = await repository.updateCategory(category);
      if (!updated) {
        return errorState(
          previousState,
          "Unpublish the category's indexed articles before changing its URL slug.",
        );
      }
    }
  } catch (error) {
    console.error("Category persistence failed.", databaseErrorDetails(error));
    return errorState(
      previousState,
      "The category could not be saved. Check that its URL slug is unique.",
    );
  }

  revalidateContent();
  return successState(
    previousState,
    request.data.mode === "create"
      ? `${request.data.name} was created.`
      : `${request.data.name} was saved.`,
  );
}

export async function deleteCategoryAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  await requireAdmin();
  const request = parseRecordRequest(formData);

  if (!request.success) {
    return errorState(previousState, "The category request is invalid.", request.fieldErrors);
  }

  const repository = await getRepository();
  const [categories, articles] = await Promise.all([
    repository.listCategories(demoIds.workspace),
    repository.listArticles(demoIds.workspace),
  ]);
  const category = categories.find((candidate) => candidate.id === request.data.id);

  if (!category) {
    return errorState(previousState, "That category no longer exists.");
  }

  const articleCount = articles.filter((article) => article.categoryId === category.id).length;
  if (articleCount > 0) {
    return errorState(
      previousState,
      `Move or delete ${articleCount} ${articleCount === 1 ? "article" : "articles"} first.`,
    );
  }

  try {
    const deleted = await repository.deleteCategory(demoIds.workspace, category.id);
    if (!deleted) {
      return errorState(
        previousState,
        "The category changed or contains articles. Reload and try again.",
      );
    }
  } catch (error) {
    console.error("Category deletion failed.", databaseErrorDetails(error));
    return errorState(previousState, "The category could not be deleted. Try again.");
  }

  revalidateContent();
  return successState(previousState, `${category.name} was deleted.`);
}

export async function saveArticleAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  await requireAdmin();
  const request = parseArticleRequest(formData);

  if (!request.success) {
    return errorState(previousState, "Review the highlighted article fields.", request.fieldErrors);
  }

  try {
    await validateArticleMdx(request.data.mdx, request.data.title);
  } catch (error) {
    const message =
      error instanceof ArticleMdxValidationError
        ? error.message
        : "Article MDX could not be validated.";
    return errorState(previousState, "The article contains unsafe or invalid MDX.", {
      mdx: message,
    });
  }

  const repository = await getRepository();
  const categories = await repository.listCategories(demoIds.workspace);
  const category = categories.find(
    (candidate) => candidate.id === request.data.categoryId,
  );
  if (!category) {
    return errorState(previousState, "Choose a category from this workspace.", {
      categoryId: "That category is unavailable",
    });
  }

  const existing =
    request.data.mode === "update"
      ? await repository.getArticle(demoIds.workspace, request.data.id)
      : null;
  if (request.data.mode === "update" && !existing) {
    return errorState(previousState, "That article no longer exists.");
  }

  const id = existing?.id ?? `article_${crypto.randomUUID()}`;
  const publishedAt =
    existing?.publishedAt ?? (request.data.status === "published" ? new Date() : null);
  const assetSelection = {
    manifestId: request.data.assetManifestId,
    hashes: referencedArticleAssetHashes(request.data.mdx),
  };

  try {
    const article = {
      id,
      workspaceId: demoIds.workspace,
      categoryId: request.data.categoryId,
      slug: request.data.slug,
      title: request.data.title,
      mdx: request.data.mdx,
      status: request.data.status,
      isFaq: request.data.isFaq,
      authorName: request.data.authorName,
      publishedAt,
    };
    const evidence = await prepareArticleEvidence(article, category.slug);

    if (request.data.mode === "create") {
      await repository.createArticle(article, assetSelection, evidence);
    } else {
      await repository.updateArticle(article, assetSelection, evidence);
    }
  } catch (error) {
    console.error("Article persistence failed.", databaseErrorDetails(error));
    const assetManifestStatus = failedArticleAssetManifestStatus(
      request.data.assetManifestId,
      error,
    );

    if (assetManifestStatus) {
      const message =
        assetManifestStatus === "discarded"
          ? "The article was not saved. Its staged image session was discarded; re-upload each unsaved image still in the source or remove it before retrying."
          : "The article was not saved and staged-image cleanup could not be confirmed. Re-upload each unsaved image still in the source or remove it before retrying.";
      return errorState(
        previousState,
        message,
        {
          mdx:
            "The previous image staging session cannot be reused. Re-upload or remove its unsaved images.",
        },
        assetManifestStatus,
      );
    }

    return errorState(
      previousState,
      "The article could not be saved. Check its URL slug and remove any image that is no longer staged for this article.",
    );
  }

  scheduleEmbeddingRecovery();
  revalidateContent();

  if (request.data.mode === "create") {
    redirect(`/admin/content/articles/${id}`);
  }

  return successState(previousState, `${request.data.title} was saved.`);
}

export async function deleteArticleAction(
  previousState: ContentActionState,
  formData: FormData,
): Promise<ContentActionState> {
  await requireAdmin();
  const request = parseRecordRequest(formData);

  if (!request.success) {
    return errorState(previousState, "The article request is invalid.", request.fieldErrors);
  }

  const repository = await getRepository();
  const article = await repository.getArticle(demoIds.workspace, request.data.id);
  if (!article) {
    return errorState(previousState, "That article no longer exists.");
  }

  try {
    await repository.deleteArticle(demoIds.workspace, article.id);
  } catch (error) {
    console.error("Article deletion failed.", databaseErrorDetails(error));
    return errorState(previousState, "The article could not be deleted. Try again.");
  }

  scheduleEmbeddingRecovery();
  revalidateContent();
  redirect("/admin/content");
}
