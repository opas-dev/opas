// ABOUTME: Exchanges an invitation or reset fragment bearer for a scoped acceptance cookie.
// ABOUTME: Rejects unknown acceptance paths before reaching the shared HTTP boundary.
import type { NextRequest } from "next/server";

import { handleMemberLinkExchange } from "@/auth/member-acceptance-http";
import { parseMemberAcceptanceKind } from "@/auth/member-acceptance";

export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<{ kind: string }>;
}>;

export async function POST(request: NextRequest, context: RouteContext) {
  const kind = parseMemberAcceptanceKind((await context.params).kind);
  if (!kind) return new Response(null, { status: 404 });
  return handleMemberLinkExchange(request, kind);
}
