// ABOUTME: Records anonymous analytics only for currently published demo articles.
// ABOUTME: Creates bounded server-side event slots without retaining visitor identifiers.
import { demoIds } from "@/db/demo";
import type { Repository } from "@/db/repository";

import {
  createArticleFeedback,
  createArticleView,
  type ArticleEventCreationOptions,
} from "./records";
import type { ArticleFeedbackRequest } from "./requests";

type ViewRepository = Pick<Repository, "getArticle" | "recordView">;
type FeedbackRepository = Pick<Repository, "getArticle" | "createFeedback">;

async function hasPublishedArticle(
  repository: Pick<Repository, "getArticle">,
  articleId: string,
) {
  const article = await repository.getArticle(demoIds.workspace, articleId);
  return article?.workspaceId === demoIds.workspace && article.status === "published";
}

export async function recordPublishedArticleView(
  repository: ViewRepository,
  articleId: string,
  options?: ArticleEventCreationOptions,
) {
  if (!(await hasPublishedArticle(repository, articleId))) {
    return false;
  }

  await repository.recordView(createArticleView(articleId, options));
  return true;
}

export async function recordPublishedArticleFeedback(
  repository: FeedbackRepository,
  articleId: string,
  feedback: ArticleFeedbackRequest,
  options?: ArticleEventCreationOptions,
) {
  if (!(await hasPublishedArticle(repository, articleId))) {
    return false;
  }

  await repository.createFeedback(createArticleFeedback(articleId, feedback, options));
  return true;
}

export function articleEventFailureDetails(error: unknown) {
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
