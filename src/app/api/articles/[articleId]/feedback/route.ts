// ABOUTME: Routes helpfulness feedback for one currently published article.
// ABOUTME: Delegates strict anonymous ingestion to the shared analytics handler.
import { handleArticleFeedbackRequest } from "@/analytics/handlers";
import { consumeArticleEventAllowance } from "@/analytics/gate";
import { getRepository } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/articles/[articleId]/feedback">,
) {
  const { articleId } = await params;
  return handleArticleFeedbackRequest(request, articleId, {
    consumeAllowance: consumeArticleEventAllowance,
    getRepository,
  });
}
