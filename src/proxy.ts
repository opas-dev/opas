// ABOUTME: Protects administrator routes and applies the embed document's frame-parent policy.
// ABOUTME: Keeps authentication and the sole frameable route within one Next.js Proxy boundary.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authorizeAdminRoute } from "@/auth/admin-route";
import { embedParentOrigins } from "@/embed/config";
import { createEmbedContentSecurityPolicy } from "@/security/headers";

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/admin")) {
    const { getAdminSessionConfig } = await import("@/auth/config");
    const { deploymentId, sessionSecret } = getAdminSessionConfig();
    return authorizeAdminRoute(request, sessionSecret, deploymentId);
  }

  const response = NextResponse.next();
  response.headers.set(
    "Content-Security-Policy",
    createEmbedContentSecurityPolicy(embedParentOrigins()),
  );
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/embed"],
};
