// ABOUTME: Resolves the scoped acceptance cookie into safe invitation or reset details.
// ABOUTME: Keeps member-link credentials and database identifiers out of the response.
import type { NextRequest } from "next/server";

import { handleMemberAcceptanceSession } from "@/auth/member-acceptance-http";
import { parseMemberAcceptanceKind } from "@/auth/member-acceptance";

export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<{ kind: string }>;
}>;

export async function GET(request: NextRequest, context: RouteContext) {
  const kind = parseMemberAcceptanceKind((await context.params).kind);
  if (!kind) return new Response(null, { status: 404 });
  return handleMemberAcceptanceSession(request, kind);
}
