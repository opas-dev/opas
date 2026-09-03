// ABOUTME: Protects administrator routes and applies the embed document's frame-parent policy.
// ABOUTME: Keeps authentication and the sole frameable route within one Next.js Proxy boundary.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authorizeAdminRoute } from "@/auth/admin-route";
import { applyArticlePreviewResponseHeaders } from "@/auth/article-preview-headers";
import { embedParentOrigins } from "@/embed/config";
import { createEmbedContentSecurityPolicy } from "@/security/headers";

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/admin")) {
    const { getAdminSessionConfig } = await import("@/auth/config");
    const { deploymentId, sessionSecret } = getAdminSessionConfig();
    return authorizeAdminRoute(request, sessionSecret, deploymentId);
  }

  if (request.nextUrl.pathname === "/preview") {
    const response = NextResponse.next();
    applyArticlePreviewResponseHeaders(response.headers);
    return response;
  }

  if (request.nextUrl.pathname.startsWith("/preview/")) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  response.headers.set(
    "Content-Security-Policy",
    createEmbedContentSecurityPolicy(embedParentOrigins()),
  );
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/embed", "/preview/:path*"],
};
