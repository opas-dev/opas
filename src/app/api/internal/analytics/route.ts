// ABOUTME: Exposes authenticated analytics retention cleanup to Docker and Vercel schedulers.
// ABOUTME: Keeps the route dynamic, uncached, and bounded by the shared cleanup runner.
import { handleAnalyticsCleanupRequest } from "@/outcomes/cleanup-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleAnalyticsCleanupRequest(request);
}

export async function POST(request: Request) {
  return handleAnalyticsCleanupRequest(request);
}
