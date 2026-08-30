// ABOUTME: Exposes idempotent support handoffs through a dynamic Node route.
// ABOUTME: Delegates payload bounds, citation verification, storage, and delivery to the service.
import { handleHandoffRequest } from "@/handoff/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleHandoffRequest(request);
}
