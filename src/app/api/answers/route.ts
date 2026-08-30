// ABOUTME: Exposes the native grounded-answer stream through a dynamic Node route.
// ABOUTME: Delegates request bounds, provider privacy, and citation authority to the answer boundary.
import { handleAnswerRequest } from "@/answers/answer-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAnswerRequest(request);
}
