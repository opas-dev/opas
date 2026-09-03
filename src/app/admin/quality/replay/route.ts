// ABOUTME: Reproduces one retained answer from its redacted evidence under administrator auth.
// ABOUTME: Keeps workspace selection and retention scope on the server and returns no raw failures.
import { requireMemberCapability } from "@/auth/admin";
import { demoIds } from "@/db/demo";
import {
  consumeQualityRequestAllowance,
  runActiveRetainedConversationReplay,
} from "@/quality/dependencies";
import { handleQualityReplayRequest } from "@/quality/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleQualityReplayRequest(request, {
    authorize: () => requireMemberCapability("quality:manage", demoIds.workspace),
    consumeAllowance: consumeQualityRequestAllowance,
    run: runActiveRetainedConversationReplay,
  });
}
