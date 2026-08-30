// ABOUTME: Starts one authenticated saved-question evaluation for the active workspace.
// ABOUTME: Leaves workspace identity and evaluation record construction on the server.
import { requireAdmin } from "@/auth/admin";
import {
  consumeQualityRequestAllowance,
  runActiveSavedQuestionSet,
} from "@/quality/dependencies";
import { handleQualityRunRequest } from "@/quality/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleQualityRunRequest(request, {
    authorize: requireAdmin,
    consumeAllowance: consumeQualityRequestAllowance,
    run: runActiveSavedQuestionSet,
  });
}
