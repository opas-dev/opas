// ABOUTME: Serves an image only when the preview cookie authorizes its exact revision.
// ABOUTME: Keeps private revision assets behind the same scoped no-store boundary.

import type { NextRequest } from "next/server";

import {
  handleArticlePreviewAsset,
  unavailableArticlePreviewResponse,
} from "@/auth/article-preview-http";
import { getArticlePreviewHttpDependencies } from "@/auth/article-preview-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: RouteContext<"/preview/assets/[hash]">,
) {
  try {
    return handleArticlePreviewAsset(
      request,
      (await params).hash,
      await getArticlePreviewHttpDependencies(),
    );
  } catch {
    return unavailableArticlePreviewResponse();
  }
}
