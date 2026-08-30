// ABOUTME: Exposes the same-origin resolver for validated embedded parent-page URLs.
// ABOUTME: Delegates all body, origin, and publication checks to the bounded context boundary.
import { handleEmbedContextRequest } from "@/embed/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleEmbedContextRequest(request);
}
