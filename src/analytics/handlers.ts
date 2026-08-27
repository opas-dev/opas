// ABOUTME: Handles anonymous article view and feedback requests behind shared safety gates.
// ABOUTME: Keeps validation, rate responses, publication checks, and persistence semantics testable.
import {
  articleEventFailureDetails,
  recordPublishedArticleFeedback,
  recordPublishedArticleView,
} from "@/analytics/events";
import {
  type ArticleEventAllowance,
  type ArticleEventKind,
} from "@/analytics/gate";
import {
  articleEventResponse,
  parseArticleFeedbackRequest,
  parseArticleViewRequest,
} from "@/analytics/requests";
import type { Repository } from "@/db/repository";

type ArticleEventRepository = Pick<
  Repository,
  "createFeedback" | "getArticle" | "recordView"
>;

type ArticleEventDependencies = {
  consumeAllowance: (
    kind: ArticleEventKind,
    request: Request,
  ) => Promise<ArticleEventAllowance>;
  getRepository: () => Promise<ArticleEventRepository>;
};

function rateLimitResponse(allowance: Extract<ArticleEventAllowance, { accepted: false }>) {
  return articleEventResponse(
    { error: "Anonymous analytics are temporarily busy. Please try again shortly." },
    429,
    { "Retry-After": String(allowance.retryAfterSeconds) },
  );
}

export async function handleArticleFeedbackRequest(
  request: Request,
  articleId: string,
  dependencies: ArticleEventDependencies,
) {
  const parsed = await parseArticleFeedbackRequest(request);
  if (!parsed.success) {
    return articleEventResponse({ error: parsed.error }, parsed.status);
  }

  const allowance = await dependencies.consumeAllowance("feedback", request);
  if (!allowance.accepted) {
    return rateLimitResponse(allowance);
  }

  try {
    const accepted = await recordPublishedArticleFeedback(
      await dependencies.getRepository(),
      articleId,
      parsed.data,
    );
    if (!accepted) {
      return articleEventResponse({ error: "Published article not found." }, 404);
    }

    return articleEventResponse({ accepted: true }, 200);
  } catch (error) {
    console.error("Article feedback persistence failed.", articleEventFailureDetails(error));
    return articleEventResponse({ error: "Feedback could not be recorded." }, 500);
  }
}

export async function handleArticleViewRequest(
  request: Request,
  articleId: string,
  dependencies: ArticleEventDependencies,
) {
  const parsed = await parseArticleViewRequest(request);
  if (!parsed.success) {
    return articleEventResponse({ error: parsed.error }, parsed.status);
  }

  const allowance = await dependencies.consumeAllowance("view", request);
  if (!allowance.accepted) {
    return rateLimitResponse(allowance);
  }

  try {
    const accepted = await recordPublishedArticleView(
      await dependencies.getRepository(),
      articleId,
    );
    if (!accepted) {
      return articleEventResponse({ error: "Published article not found." }, 404);
    }

    return articleEventResponse({ accepted: true }, 200);
  } catch (error) {
    console.error("Article view persistence failed.", articleEventFailureDetails(error));
    return articleEventResponse({ error: "View could not be recorded." }, 500);
  }
}
