// ABOUTME: Mounts the public read-only MCP endpoint on the shared Next.js application.
// ABOUTME: Applies one strict request boundary to every supported HTTP method.
import { handleMcpRequest } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function routeRequest(request: Request) {
  return handleMcpRequest(request);
}

export const POST = routeRequest;
export const GET = routeRequest;
export const DELETE = routeRequest;
export const PATCH = routeRequest;
export const PUT = routeRequest;
export const OPTIONS = routeRequest;
