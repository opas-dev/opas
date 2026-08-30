// ABOUTME: Exposes bounded low-rating and abandonment updates for retained answer records.
// ABOUTME: Delegates validation, abuse admission, redaction, and persistence to the shared route.
import { handlePublicOutcomeRequest } from "@/outcomes/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlePublicOutcomeRequest(request);
}
