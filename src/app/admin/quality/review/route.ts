// ABOUTME: Imports authenticated human scoring for a completed active-workspace evaluation.
// ABOUTME: Keeps run identity, aggregate recomputation, and persistence on the server.
import { requireAdmin } from "@/auth/admin";
import {
  consumeQualityRequestAllowance,
  importActiveQualityReview,
} from "@/quality/dependencies";
import { handleQualityReviewRequest } from "@/quality/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleQualityReviewRequest(request, {
    authorize: requireAdmin,
    consumeAllowance: consumeQualityRequestAllowance,
    importReview: importActiveQualityReview,
  });
}
