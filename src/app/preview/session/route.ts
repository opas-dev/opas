// ABOUTME: Rechecks the signed-preview cookie after client-side fragment exchange.
// ABOUTME: Clears invalid preview credentials without returning revision content.

import type { NextRequest } from "next/server";

import {
  handleArticlePreviewSession,
  unavailableArticlePreviewResponse,
} from "@/auth/article-preview-http";
import { getArticlePreviewHttpDependencies } from "@/auth/article-preview-request";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    return handleArticlePreviewSession(
      request,
      await getArticlePreviewHttpDependencies(),
    );
  } catch {
    return unavailableArticlePreviewResponse();
  }
}
