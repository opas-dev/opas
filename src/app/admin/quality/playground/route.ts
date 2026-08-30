// ABOUTME: Runs one authenticated, ephemeral answer check against the active workspace.
// ABOUTME: Returns bounded answer and source fields without exposing provider failures.
import { requireAdmin } from "@/auth/admin";
import {
  consumeQualityRequestAllowance,
  runActiveQualityPlayground,
} from "@/quality/dependencies";
import { handleQualityPlaygroundRequest } from "@/quality/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleQualityPlaygroundRequest(request, {
    authorize: requireAdmin,
    consumeAllowance: consumeQualityRequestAllowance,
    run: runActiveQualityPlayground,
  });
}
