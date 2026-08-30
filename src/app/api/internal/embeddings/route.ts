// ABOUTME: Exposes authenticated embedding recovery to deployment schedulers and operators.
// ABOUTME: Keeps the private route dynamic, uncached, and bounded by fixed job and wall-clock budgets.
import { handleEmbeddingRecoveryRequest } from "@/ai/embedding-recovery-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleEmbeddingRecoveryRequest(request);
}

export async function POST(request: Request) {
  return handleEmbeddingRecoveryRequest(request);
}
