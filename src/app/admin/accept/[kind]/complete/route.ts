// ABOUTME: Completes a one-time invitation or credential reset from its scoped cookie.
// ABOUTME: Delegates validation and atomic consumption to the member-acceptance boundary.
import type { NextRequest } from "next/server";

import { handleMemberAcceptanceCompletion } from "@/auth/member-acceptance-http";
import { parseMemberAcceptanceKind } from "@/auth/member-acceptance";

export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<{ kind: string }>;
}>;

export async function POST(request: NextRequest, context: RouteContext) {
  const kind = parseMemberAcceptanceKind((await context.params).kind);
  if (!kind) return new Response(null, { status: 404 });
  return handleMemberAcceptanceCompletion(request, kind);
}
