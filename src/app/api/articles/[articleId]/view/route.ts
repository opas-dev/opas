// ABOUTME: Routes privacy-light view events for one currently published article.
// ABOUTME: Delegates bounded anonymous ingestion to the shared analytics handler.
import { handleArticleViewRequest } from "@/analytics/handlers";
import { consumeArticleEventAllowance } from "@/analytics/gate";
import { getRepository } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/articles/[articleId]/view">,
) {
  const { articleId } = await params;
  return handleArticleViewRequest(request, articleId, {
    consumeAllowance: consumeArticleEventAllowance,
    getRepository,
  });
}
