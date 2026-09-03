// ABOUTME: Exchanges one signed-preview fragment bearer for a scoped HttpOnly cookie.
// ABOUTME: Delegates origin, body, grant, and expiry checks to the preview HTTP boundary.

import type { NextRequest } from "next/server";

import {
  handleArticlePreviewExchange,
  unavailableArticlePreviewResponse,
} from "@/auth/article-preview-http";
import { getArticlePreviewHttpDependencies } from "@/auth/article-preview-request";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    return handleArticlePreviewExchange(
      request,
      await getArticlePreviewHttpDependencies(),
    );
  } catch {
    return unavailableArticlePreviewResponse();
  }
}
